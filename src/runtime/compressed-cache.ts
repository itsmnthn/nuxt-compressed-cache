import type { H3Event } from 'nitro/h3'
import { createHash, randomUUID } from 'node:crypto'
import { promisify } from 'node:util'
import { brotliCompress, brotliCompressSync, brotliDecompressSync, constants, gunzipSync, gzip, gzipSync } from 'node:zlib'
import { serverFetch } from 'nitro/app'
import { defineMiddleware, toResponse } from 'nitro/h3'
import { useStorage } from 'nitro/storage'

/**
 * Compressed cache that stores rendered HTML and payloads pre-compressed (brotli and/or gzip) and serves the bytes as-is,
 * so a hit costs a small read instead of a JSON parse, and a render pays compression once instead of per request.
 * It follows Nitro's route cache rules (stale-while-revalidate, 200 only, no cookies) without header or cookie variants.
 */

export type Encoding = 'br' | 'gzip'

/** Per route settings, set through the `compressedCache` route rule. */
export interface CompressedCacheRule {
  /** Seconds a copy is fresh. */
  maxAge: number
  /**
   * Seconds a copy may still be served while it re-renders in the background, after `maxAge`.
   * Unset serves stale copies until replaced, `0` always waits for a fresh render.
   * When set, entries also get a storage TTL of `maxAge + staleMaxAge`.
   */
  staleMaxAge?: number
  /** Query params that get their own entry. A request with a param in neither this nor `stripQuery` skips the cache. */
  allowQuery?: string[]
  /** Query params that do not change the page, added to the module's `stripQuery`. A trailing `*` matches by prefix. */
  stripQuery?: string[]
  /** Requests carrying any of these cookies skip the cache, for example a session cookie. */
  bypassCookies?: string[]
}

export interface CompressedCacheOptions extends CompressedCacheConfig {
  /** The rule for a page pathname, or `undefined` to leave the request alone. A payload is looked up by its page. */
  rule: ({ pathname }: { pathname: string }) => CompressedCacheRule | undefined
}

/** Settings shared by every cached route, the module passes these through runtime config. */
export interface CompressedCacheConfig {
  /** Storage mount for entries. */
  storage?: string
  /** Key prefix inside the storage mount. */
  prefix?: string
  /**
   * Query params every rule drops from the key, a trailing `*` matches by prefix.
   * A request with one is served an existing entry but never stored, the page may echo the query.
   */
  stripQuery?: string[]
  /**
   * Compressed copies to store. Both serve every client as-is, brotli only halves storage
   * and converts the rare gzip-only request on the fly.
   */
  encodings?: Encoding[]
  /** Brotli quality used once per render. */
  brotliQuality?: number
  /** Gzip level used once per render. */
  gzipLevel?: number
  /** Response header that reports `HIT`, `STALE` or `MISS`, `false` to omit it. */
  statusHeader?: string | false
  /**
   * The build id. A page entry stored by another build is rendered again before it is sent,
   * and payloads are kept per build like the `_b` param Nuxt adds to them.
   */
  version?: string
}

/** Where entries live, also what the invalidation helpers need. */
export interface CompressedCacheLocation {
  storage?: string
  prefix?: string
}

interface CompressedCacheMeta {
  /** Pathname with its allowed query, used by prefix invalidation. */
  path: string
  status: number
  headers: Record<string, string>
  etag: string
  createdAt: number
  version?: string
  /** Set by `expireCompressedCache`, the next request serves this copy once and re-renders. */
  expired?: boolean
  /** Byte sizes, a mismatch on read means a partially written file and is treated as a miss. */
  size: Partial<Record<Encoding, number>>
}

interface StoredPage {
  meta: CompressedCacheMeta
  body: Partial<Record<Encoding, Uint8Array<ArrayBuffer>>>
}

const brotliAsync = promisify(brotliCompress)
const gzipAsync = promisify(gzip)

export const DEFAULT_STORAGE = 'cache'
export const DEFAULT_PREFIX = 'compressed-cache'
/** Preference order when the client weights several encodings the same. */
const ENCODINGS: Encoding[] = ['br', 'gzip']
/** Encoding to storage key suffix. */
const ENCODING_FILE: Record<Encoding, string> = { br: 'br', gzip: 'gz' }
/** Headers that belong to one transfer, not to the stored page. */
const SKIPPED_HEADERS = new Set(['content-encoding', 'content-length', 'transfer-encoding', 'set-cookie', 'etag', 'vary'])
const CACHEABLE_TYPE = /^(?:text\/html|application\/json)\b/i
const REVALIDATE_HEADER = 'x-compressed-cache-revalidate'
/** Nuxt payloads live next to their page, clients request them with the build id in `_b`. */
const PAYLOAD_SUFFIX = '/_payload.json'
const BUILD_PARAM = '_b'
export const DEFAULT_STRIP_QUERY = ['utm_*', 'fbclid', 'gclid', 'ref']
/** Caps the unknown query param names logged per process, anyone can send random names. */
const MAX_LOGGED_QUERY = 100
/** Per process, so only this server's own background requests can force a re-render. */
const REVALIDATE_TOKEN = randomUUID()

/** Renders in progress per entry, so concurrent misses render once. */
const inflight = new Map<string, Promise<StoredPage | undefined>>()
/** Unknown query param names already logged. */
const loggedQuery = new Set<string>()

/**
 * Picks the available encoding the client weights highest (`q`, default 1, `*` for unlisted ones),
 * brotli on a tie, and never one the client did not accept.
 *
 * @returns The encoding to send, or `undefined` when the client accepts none of them.
 */
export function negotiateEncoding(acceptEncoding: string | null, available: Encoding[] = ENCODINGS): Encoding | undefined {
  const weights = new Map<string, number>()

  for (const part of (acceptEncoding ?? '').toLowerCase().split(',')) {
    const [name, ...params] = part.split(';').map(value => value.trim())
    const quality = params.find(param => param.startsWith('q='))
    if (name) {
      weights.set(name, quality ? Number(quality.slice(2)) || 0 : 1)
    }
  }

  let best: Encoding | undefined
  let bestWeight = 0
  for (const encoding of ENCODINGS) {
    const weight = weights.get(encoding) ?? weights.get('*') ?? 0
    if (available.includes(encoding) && weight > bestWeight) {
      best = encoding
      bestWeight = weight
    }
  }

  return best
}

/**
 * Only plain successful pages without cookies or a no-store/private policy are shared.
 * A body something else already encoded is left alone rather than encoded twice.
 */
function isCacheable(response: Response): boolean {
  const cacheControl = response.headers.get('cache-control') ?? ''
  const encoding = response.headers.get('content-encoding')

  return response.status === 200
    && !response.headers.has('set-cookie')
    && !/\b(?:no-store|private)\b/i.test(cacheControl)
    && (!encoding || encoding === 'identity')
    && CACHEABLE_TYPE.test(response.headers.get('content-type') ?? '')
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex').slice(0, 32)
}

/** All entries of one pathname (every allowed query variant) share this base. */
function pathKey({ prefix, pathname }: { prefix: string, pathname: string }): string {
  return `${prefix}:${hash(pathname)}`
}

function entryKey({ prefix, pathname, query }: { prefix: string, pathname: string, query: string }): string {
  return `${pathKey({ prefix, pathname })}:${query ? hash(query) : 'default'}`
}

/** Whether a query param name is listed, an entry ending in `*` matches by prefix. */
function matchesQuery({ name, list }: { name: string, list: string[] }): boolean {
  return list.some(entry => entry.endsWith('*') ? name.startsWith(entry.slice(0, -1)) : entry === name)
}

/**
 * Keeps only allowed query params, sorted so their order does not split entries, and drops stripped ones.
 * A payload of a versioned app is also keyed by its build, the requested `_b` or the running build.
 *
 * @returns The query that keys the entry, the names of params in neither list, whether the request had stripped params,
 * and whether it is for the running build, the last two needed to store it.
 */
function normalizeQuery({ search, allowQuery = [], stripQuery = [], payload, version }: {
  search: string
  allowQuery?: string[]
  stripQuery?: string[]
  payload: boolean
  version?: string
}): { query: string, unknown: string[], stripped: boolean, currentBuild: boolean } {
  const params = [...new URLSearchParams(search)]
  const keyed = payload ? params.filter(([name]) => name !== BUILD_PARAM) : params
  const allowed = keyed.filter(([name]) => allowQuery.includes(name)).sort(([a], [b]) => a.localeCompare(b))
  const rest = keyed.filter(([name]) => !allowQuery.includes(name)).map(([name]) => name)
  const unknown = [...new Set(rest.filter(name => !matchesQuery({ name, list: stripQuery })))]
  const stripped = rest.length > 0 && unknown.length < rest.length
  if (!payload || !version) {
    return { query: new URLSearchParams(allowed).toString(), unknown, stripped, currentBuild: true }
  }

  const build = new URLSearchParams(search).get(BUILD_PARAM) ?? version
  return { query: new URLSearchParams([...allowed, [BUILD_PARAM, build]]).toString(), unknown, stripped, currentBuild: build === version }
}

/** Tells once per param name, up to a cap, why requests with it skip the cache. */
function logUnknownQuery({ pathname, names }: { pathname: string, names: string[] }): void {
  for (const name of names) {
    if (loggedQuery.has(name) || loggedQuery.size >= MAX_LOGGED_QUERY) {
      continue
    }
    loggedQuery.add(name)
    console.warn(`[compressed-cache] ${pathname} skipped the cache: query param "${name}" isn't configured. Add it to allowQuery to cache a copy per value, or stripQuery if it doesn't change the page.`)
  }
}

/** The page pathname a request or stored path belongs to, a payload belongs to its page. */
function pagePathname(path: string): string {
  const pathname = path.split('?')[0]!
  return pathname.endsWith(PAYLOAD_SUFFIX) ? pathname.slice(0, -PAYLOAD_SUFFIX.length) || '/' : pathname
}

/** The payload path that belongs to a page path. */
function payloadPath(path: string): string {
  return path.replace(/\/$/, '') + PAYLOAD_SUFFIX
}

function hasCookie({ cookieHeader, names }: { cookieHeader: string | null, names: string[] }): boolean {
  const present = (cookieHeader ?? '').split(';').map(cookie => cookie.split('=')[0]!.trim())

  return names.some(name => present.includes(name))
}

/**
 * Weak comparison against an `If-None-Match` list, `*` matches any stored page.
 *
 * @returns Whether the client already has this copy.
 */
function matchesEtag({ ifNoneMatch, etag }: { ifNoneMatch: string | null, etag: string }): boolean {
  const opaque = etag.replace(/^W\//, '')

  return (ifNoneMatch ?? '').split(',').some((tag) => {
    const value = tag.trim()
    return value === '*' || value.replace(/^W\//, '') === opaque
  })
}

/** Deletes an entry's meta and every compressed copy. */
async function removeEntry({ storage, entry }: { storage: string, entry: string }): Promise<void> {
  const store = useStorage(storage)
  await Promise.all(['meta', ...Object.values(ENCODING_FILE)].map(file => store.removeItem(`${entry}:${file}`)))
}

/** Stored copies are compressed once per render, so they can use a slower, smaller setting. */
async function compressStored({ encoding, raw, config }: { encoding: Encoding, raw: Uint8Array, config: CompressedCacheConfig }) {
  return encoding === 'br'
    ? brotliAsync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: config.brotliQuality ?? 6, [constants.BROTLI_PARAM_SIZE_HINT]: raw.byteLength } })
    : gzipAsync(raw, { level: config.gzipLevel ?? 6 })
}

/**
 * Converts a stored copy for a client that accepts another encoding, or none, using the fastest setting.
 *
 * @returns Bytes in the target encoding, or uncompressed bytes when there is no target.
 */
function convert({ body, from, to }: { body: Uint8Array, from: Encoding, to: Encoding | undefined }): Uint8Array<ArrayBuffer> {
  const raw = from === 'br' ? brotliDecompressSync(body) : gunzipSync(body)
  if (to === 'br') {
    return brotliCompressSync(raw, { params: { [constants.BROTLI_PARAM_QUALITY]: 1 } })
  }
  return to === 'gzip' ? gzipSync(raw, { level: 1 }) : raw
}

/**
 * Reads the meta and the one compressed copy this request needs.
 *
 * @returns The stored page with only that copy, or `undefined` when missing or partially written.
 */
async function readPage({ storage, key, encoding }: { storage: string, key: string, encoding: Encoding }): Promise<StoredPage | undefined> {
  const store = useStorage(storage)
  const meta = await store.getItem<CompressedCacheMeta>(`${key}:meta`)
  if (!meta) {
    return
  }

  const bytes = await store.getItemRaw<Uint8Array<ArrayBuffer>>(`${key}:${ENCODING_FILE[encoding]}`)
  if (!bytes || bytes.byteLength !== meta.size[encoding]) {
    return
  }

  return { meta, body: { [encoding]: bytes } }
}

/**
 * Renders through the rest of the app and stores the configured compressed copies when the response is cacheable.
 *
 * @returns The live response when it is not cacheable, otherwise the stored page.
 */
async function renderPage({ event, next, storage, key, path, rule, encodings, config }: {
  event: H3Event
  next: () => unknown
  storage: string
  key: string
  path: string
  rule: CompressedCacheRule
  encodings: Encoding[]
  config: CompressedCacheConfig
}): Promise<{ response?: Response, page?: StoredPage }> {
  const response = await toResponse(await next(), event)
  if (!isCacheable(response)) {
    return { response }
  }

  const raw = new Uint8Array(await response.arrayBuffer())
  const compressed = await Promise.all(encodings.map(encoding => compressStored({ encoding, raw, config })))
  const body: StoredPage['body'] = {}
  const size: CompressedCacheMeta['size'] = {}
  encodings.forEach((encoding, index) => {
    body[encoding] = compressed[index]
    size[encoding] = compressed[index]!.byteLength
  })

  const headers: Record<string, string> = {}
  response.headers.forEach((value, name) => {
    if (!SKIPPED_HEADERS.has(name)) {
      headers[name] = value
    }
  })
  const meta: CompressedCacheMeta = {
    path,
    status: response.status,
    headers,
    etag: `W/"${createHash('sha1').update(raw).digest('base64url')}"`,
    createdAt: Date.now(),
    version: config.version,
    size,
  }

  const store = useStorage(storage)
  const ttl = rule.staleMaxAge === undefined ? undefined : { ttl: rule.maxAge + rule.staleMaxAge }
  // copies first and meta last, so a reader never finds meta pointing at missing files
  try {
    await Promise.all(encodings.map(encoding => store.setItemRaw(`${key}:${ENCODING_FILE[encoding]}`, body[encoding], ttl)))
    await store.setItem(`${key}:meta`, meta, ttl)
  }
  catch (error) {
    // the render is still good to send, a failed write only means the next request renders again
    console.error('[compressed-cache] storing failed', error)
  }

  return { page: { meta, body } }
}

/** Builds the response for a stored page, converting only when the client does not accept the stored copy. */
function sendPage({ event, page, source, target, state, statusHeader }: {
  event: H3Event
  page: StoredPage
  /** Stored copy to send from. */
  source: Encoding
  /** Encoding the client accepts best, `undefined` for an uncompressed body. */
  target: Encoding | undefined
  state: 'HIT' | 'STALE' | 'MISS'
  statusHeader: string | false
}): Response {
  const headers = new Headers(page.meta.headers)
  headers.set('etag', page.meta.etag)
  headers.append('vary', 'accept-encoding')
  if (statusHeader) {
    headers.set(statusHeader, state)
  }

  if (matchesEtag({ ifNoneMatch: event.req.headers.get('if-none-match'), etag: page.meta.etag })) {
    return new Response(null, { status: 304, headers })
  }

  const stored = page.body[source]!
  const body = source === target ? stored : convert({ body: stored, from: source, to: target })
  if (target) {
    headers.set('content-encoding', target)
  }
  headers.set('content-length', String(body.byteLength))

  return new Response(event.req.method === 'HEAD' ? null : body, { status: page.meta.status, headers })
}

/** Re-renders a stale page in the background through an internal request that skips the cached copy. */
function revalidate({ event, key, path }: { event: H3Event, key: string, path: string }): void {
  if (inflight.has(key)) {
    return
  }

  const task = serverFetch(new URL(path, event.url.origin), { headers: { [REVALIDATE_HEADER]: REVALIDATE_TOKEN } })
    .then(async (response) => {
      await response.body?.cancel()
      return undefined
    })
    .catch((error: unknown) => {
      console.error('[compressed-cache] revalidation failed', error)
      return undefined
    })
    .finally(() => inflight.delete(key))

  inflight.set(key, task)
  event.req.waitUntil?.(task)
}

/**
 * Lists the entry keys (without the `:meta` suffix) for one pathname and its payload,
 * or for every stored path under a prefix.
 *
 * @returns Entry keys to expire or remove.
 */
async function findEntries({ storage = DEFAULT_STORAGE, prefix = DEFAULT_PREFIX, path, pathPrefix }: CompressedCacheLocation & {
  path?: string
  pathPrefix?: string
}): Promise<string[]> {
  const store = useStorage(storage)
  const bases = path ? [path, payloadPath(path)].map(pathname => pathKey({ prefix, pathname })) : [prefix]
  const metaKeys = (await Promise.all(bases.map(base => store.getKeys(base)))).flat().filter(key => key.endsWith(':meta'))
  const entries: string[] = []

  for (const metaKey of metaKeys) {
    if (!path) {
      const meta = await store.getItem<CompressedCacheMeta>(metaKey)
      if (!meta?.path.startsWith(pathPrefix ?? '/')) {
        continue
      }
    }
    entries.push(metaKey.slice(0, -':meta'.length))
  }

  return entries
}

/**
 * Marks cached copies stale, each is served once more while it re-renders in the background.
 * Pass `path` for one page (all its allowed query variants and its payload) or `pathPrefix` for every page under it.
 *
 * @returns How many entries were expired.
 */
export async function expireCompressedCache(target: CompressedCacheLocation & { path: string } | CompressedCacheLocation & { pathPrefix: string }): Promise<number> {
  const store = useStorage(target.storage ?? DEFAULT_STORAGE)
  const entries = await findEntries(target)

  for (const entry of entries) {
    const meta = await store.getItem<CompressedCacheMeta>(`${entry}:meta`)
    if (meta) {
      await store.setItem(`${entry}:meta`, { ...meta, expired: true })
    }
  }

  return entries.length
}

/**
 * Deletes cached copies, the next request renders fresh.
 * Pass `path` for one page (all its allowed query variants and its payload) or `pathPrefix` for every page under it.
 *
 * @returns How many entries were removed.
 */
export async function removeCompressedCache(target: CompressedCacheLocation & { path: string } | CompressedCacheLocation & { pathPrefix: string }): Promise<number> {
  const entries = await findEntries(target)

  await Promise.all(entries.map(entry => removeEntry({ storage: target.storage ?? DEFAULT_STORAGE, entry })))

  return entries.length
}

/**
 * Deletes entries past the `maxAge` (plus `staleMaxAge` when set) of their page's current route rule,
 * and entries whose page no longer has a rule, or, with `olderThan`, entries rendered more than that many
 * seconds ago. Judged by each entry's own render time, so it works on every storage driver,
 * including ones without file times (memory, redis, KV). Meant for a scheduled Nitro task.
 *
 * @returns How many entries were removed.
 */
export async function pruneCompressedCache({ storage = DEFAULT_STORAGE, prefix = DEFAULT_PREFIX, ...by }: CompressedCacheLocation & (
  | { /** Age in seconds. */ olderThan: number }
  | { rule: CompressedCacheOptions['rule'] }
)): Promise<number> {
  const store = useStorage(storage)
  const now = Date.now()
  const metaKeys = (await store.getKeys(prefix)).filter(key => key.endsWith(':meta'))
  let removed = 0

  for (const metaKey of metaKeys) {
    const meta = await store.getItem<CompressedCacheMeta>(metaKey)
    // without `staleMaxAge` a stale copy is served until replaced, so an unvisited one goes once `maxAge` passes
    const rule = meta && 'rule' in by ? by.rule({ pathname: pagePathname(meta.path) }) : undefined
    const lifetime = 'olderThan' in by ? by.olderThan : rule ? rule.maxAge + (rule.staleMaxAge ?? 0) : 0
    if (meta && meta.createdAt + lifetime * 1000 > now) {
      continue
    }

    await removeEntry({ storage, entry: metaKey.slice(0, -':meta'.length) })
    removed++
  }

  return removed
}

/** Creates the compressed cache middleware. */
export function defineCompressedCache(options: CompressedCacheOptions) {
  const storage = options.storage ?? DEFAULT_STORAGE
  const prefix = options.prefix ?? DEFAULT_PREFIX
  const statusHeader = options.statusHeader ?? 'x-cache'
  const encodings = ENCODINGS.filter(encoding => (options.encodings ?? ENCODINGS).includes(encoding))
  if (!encodings.length) {
    throw new Error('[compressed-cache] `encodings` needs at least one of br or gzip')
  }

  return defineMiddleware(async (event, next) => {
    if (import.meta.dev || import.meta.prerender || (event.req.method !== 'GET' && event.req.method !== 'HEAD')) {
      return next()
    }

    const { pathname, search } = event.url
    const payload = pathname.endsWith(PAYLOAD_SUFFIX)
    // Nuxt serves a payload for its page's route rule, an exact rule like `/` does not match `/_payload.json`
    const rule = options.rule({ pathname: pagePathname(pathname) })
    if (!rule || (rule.bypassCookies?.length && hasCookie({ cookieHeader: event.req.headers.get('cookie'), names: rule.bypassCookies }))) {
      return next()
    }

    const stripQuery = [...(options.stripQuery ?? DEFAULT_STRIP_QUERY), ...(rule.stripQuery ?? [])]
    const { query, unknown, stripped, currentBuild } = normalizeQuery({ search, allowQuery: rule.allowQuery, stripQuery, payload, version: options.version })
    // a param in neither list may change the page, so a stored copy is never sent for it
    if (unknown.length) {
      logUnknownQuery({ pathname, names: unknown })
      return next()
    }
    const key = entryKey({ prefix, pathname, query })
    const path = query ? `${pathname}?${query}` : pathname

    if (event.req.headers.get(REVALIDATE_HEADER) === REVALIDATE_TOKEN) {
      const { response } = await renderPage({ event, next, storage, key, path, rule, encodings, config: options })
      // a page that is gone, moved or no longer shareable stops serving its last stored copy,
      // only a server error keeps it, so a short outage does not empty the cache
      if (response && response.status < 500) {
        await removeEntry({ storage, entry: key })
      }
      return response ?? new Response(null, { status: 204 })
    }

    const acceptEncoding = event.req.headers.get('accept-encoding')
    // send a stored copy the client accepts as-is, convert only when it accepts none of them,
    // and send it uncompressed when it accepts no compression at all
    const accepted = negotiateEncoding(acceptEncoding, encodings)
    const source = accepted ?? encodings[0]!
    const target = accepted ?? negotiateEncoding(acceptEncoding)

    const cached = await readPage({ storage, key, encoding: source })
    // a page from another build points at that build's assets, so it renders again before it is sent,
    // payloads are keyed by build instead, so a tab still on an old build gets the payload its code expects
    if (cached && (payload || cached.meta.version === options.version)) {
      const age = Date.now() - cached.meta.createdAt
      if (!cached.meta.expired && age <= rule.maxAge * 1000) {
        return sendPage({ event, page: cached, source, target, state: 'HIT', statusHeader })
      }
      // only the running build can render a replacement
      if (currentBuild && (rule.staleMaxAge === undefined || (rule.staleMaxAge > 0 && age <= (rule.maxAge + rule.staleMaxAge) * 1000))) {
        revalidate({ event, key, path })
        return sendPage({ event, page: cached, source, target, state: 'STALE', statusHeader })
      }
    }

    // stripped params and payloads of another build are served from the entry when it exists, but never stored,
    // the render may echo the query (links, canonical), and a HEAD response has no body to store
    if (stripped || !currentBuild || event.req.method === 'HEAD') {
      return next()
    }

    const pending = inflight.get(key)
    if (pending) {
      // a background revalidation resolves without the page, it is in storage by then
      const page = await pending ?? await readPage({ storage, key, encoding: source })
      return page ? sendPage({ event, page, source, target, state: 'MISS', statusHeader }) : next()
    }

    const task = renderPage({ event, next, storage, key, path, rule, encodings, config: options })
    inflight.set(key, task.then(({ page }) => page, () => undefined))
    try {
      const { response, page } = await task
      return page ? sendPage({ event, page, source, target, state: 'MISS', statusHeader }) : response
    }
    finally {
      inflight.delete(key)
    }
  })
}
