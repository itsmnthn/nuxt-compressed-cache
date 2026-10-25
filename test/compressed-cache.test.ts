import type { H3 as H3App } from 'nitro/h3'
import type { CompressedCacheRule } from '#src/runtime/compressed-cache'
import { brotliDecompressSync, gunzipSync, gzipSync } from 'node:zlib'
import { H3 } from 'nitro/h3'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const items = new Map<string, unknown>()
const ttls = new Map<string, number | undefined>()
const storage = {
  getItem: async (key: string) => items.get(key) ?? null,
  setItem: async (key: string, value: unknown, opts?: { ttl?: number }) => {
    items.set(key, value)
    ttls.set(key, opts?.ttl)
  },
  getItemRaw: async (key: string) => items.get(key) ?? null,
  setItemRaw: async (key: string, value: unknown, opts?: { ttl?: number }) => {
    items.set(key, value)
    ttls.set(key, opts?.ttl)
  },
  getKeys: async (base: string) => [...items.keys()].filter(key => key.startsWith(base)),
  removeItem: async (key: string) => void items.delete(key),
}
const app = { current: undefined as H3App | undefined }

vi.mock('nitro/storage', () => ({ useStorage: () => storage }))
vi.mock('nitro/app', () => ({
  serverFetch: (url: URL, init: RequestInit) => app.current!.fetch(new Request(url, init)),
}))

const PAGE = `<!DOCTYPE html><html><body>${'I am gonna get squashed '.repeat(500)}</body></html>`

describe('compressed cache', () => {
  let renders: number
  let body: string
  let status: number
  let cacheControl: string | undefined

  async function createApp({ encodings, rule = { maxAge: 60 }, version, keep = false }: {
    encodings?: ('br' | 'gzip')[]
    rule?: CompressedCacheRule
    version?: string
    /** Keeps stored entries, like a new build reusing persistent storage. */
    keep?: boolean
  } = {}) {
    vi.resetModules()
    if (!keep) {
      items.clear()
      ttls.clear()
    }
    renders = 0
    body = PAGE
    status = 200
    cacheControl = undefined

    const { defineCompressedCache } = await import('#src/runtime/compressed-cache')
    app.current = new H3({ silent: true })
    app.current.use(defineCompressedCache({ rule: ({ pathname }) => pathname.startsWith('/blog/') ? rule : undefined, encodings, version }))
    app.current.get('/blog/:slug', async (event) => {
      renders++
      await new Promise(resolve => setTimeout(resolve, 5))
      event.res.headers.set('content-type', 'text/html;charset=utf-8')
      if (event.url.pathname === '/blog/cookie') {
        event.res.headers.set('set-cookie', 'a=1')
      }
      if (event.url.pathname === '/blog/missing') {
        event.res.status = 404
      }
      if (cacheControl) {
        event.res.headers.set('cache-control', cacheControl)
      }
      if (event.url.pathname === '/blog/encoded') {
        event.res.headers.set('content-encoding', 'gzip')
        return gzipSync(body)
      }
      if (status !== 200) {
        event.res.status = status
      }
      return body
    })
    app.current.get('/blog/:slug/_payload.json', (event) => {
      renders++
      event.res.headers.set('content-type', 'application/json;charset=utf-8')
      return JSON.stringify({ slug: event.context.params?.slug, renders })
    })
    app.current.get('/about', () => 'about')
  }

  beforeEach(() => createApp())

  afterEach(() => {
    vi.restoreAllMocks()
  })

  const get = (path: string, headers: Record<string, string> = { 'accept-encoding': 'gzip, br' }, method = 'GET') =>
    app.current!.fetch(new Request(`http://localhost${path}`, { method, headers }))

  it('negotiates by client weights, brotli only on a tie, never an unaccepted encoding', async () => {
    const { negotiateEncoding } = await import('#src/runtime/compressed-cache')

    expect(negotiateEncoding('gzip, deflate, br, zstd')).toBe('br')
    expect(negotiateEncoding('gzip')).toBe('gzip')
    expect(negotiateEncoding('br')).toBe('br')
    expect(negotiateEncoding('gzip;q=1, br;q=0.5')).toBe('gzip')
    expect(negotiateEncoding('br;q=0.5, gzip;q=0.5')).toBe('br')
    expect(negotiateEncoding('br;q=0, gzip;q=0.8')).toBe('gzip')
    expect(negotiateEncoding('gzip;q=0')).toBeUndefined()
    expect(negotiateEncoding('*')).toBe('br')
    expect(negotiateEncoding('*;q=0.5, br;q=0')).toBe('gzip')
    expect(negotiateEncoding('identity')).toBeUndefined()
    expect(negotiateEncoding('gzip, br', ['gzip'])).toBe('gzip')
    expect(negotiateEncoding('gzip', ['br'])).toBeUndefined()
    expect(negotiateEncoding(null)).toBeUndefined()
    expect(negotiateEncoding('')).toBeUndefined()
  })

  it('sends exactly what each client accepts', async () => {
    await get('/blog/respect')
    const cases: [string | undefined, string | null][] = [
      ['br', 'br'],
      ['gzip', 'gzip'],
      ['gzip;q=1, br;q=0.5', 'gzip'],
      ['identity', null],
      [undefined, null],
    ]

    for (const [acceptEncoding, expected] of cases) {
      const response = await get('/blog/respect', acceptEncoding ? { 'accept-encoding': acceptEncoding } : {})
      const bytes = new Uint8Array(await response.arrayBuffer())
      const text = expected === 'br' ? brotliDecompressSync(bytes) : expected === 'gzip' ? gunzipSync(bytes) : bytes

      expect(response.headers.get('content-encoding'), acceptEncoding).toBe(expected)
      expect(new TextDecoder().decode(text), acceptEncoding).toBe(PAGE)
    }
    expect(renders).toBe(1)
  })

  it('renders once, then serves stored brotli, gzip, and plain bodies', async () => {
    const miss = await get('/blog/hello-world')
    expect(miss.headers.get('x-cache')).toBe('MISS')
    expect(miss.headers.get('content-encoding')).toBe('br')
    expect(miss.headers.get('vary')).toContain('accept-encoding')
    expect(brotliDecompressSync(new Uint8Array(await miss.arrayBuffer())).toString()).toBe(PAGE)

    const hit = await get('/blog/hello-world', { 'accept-encoding': 'gzip' })
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await hit.arrayBuffer())).toString()).toBe(PAGE)

    const plain = await get('/blog/hello-world', {})
    expect(plain.headers.get('content-encoding')).toBeNull()
    expect(await plain.text()).toBe(PAGE)
    expect(plain.headers.get('content-type')).toBe('text/html;charset=utf-8')
    expect(renders).toBe(1)
  })

  it('answers HEAD without a body and If-None-Match with 304', async () => {
    const first = await get('/blog/etag')
    const etag = first.headers.get('etag')!

    const head = await get('/blog/etag', { 'accept-encoding': 'br' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(await head.text()).toBe('')

    const notModified = await get('/blog/etag', { 'accept-encoding': 'br', 'if-none-match': etag })
    expect(notModified.status).toBe(304)
    expect((await get('/blog/etag', { 'if-none-match': `"other", ${etag.slice(2)}` })).status).toBe(304)
    expect((await get('/blog/etag', { 'if-none-match': '*' })).status).toBe(304)
    expect((await get('/blog/etag', { 'if-none-match': '"other"' })).status).toBe(200)
    expect(renders).toBe(1)
  })

  it('never stores the empty body of a HEAD miss', async () => {
    const head = await get('/blog/head-first', { 'accept-encoding': 'br' }, 'HEAD')
    expect(head.status).toBe(200)
    expect(items.size).toBe(0)

    const page = await get('/blog/head-first', { 'accept-encoding': 'gzip' })
    expect(page.headers.get('x-cache')).toBe('MISS')
    expect(gunzipSync(new Uint8Array(await page.arrayBuffer())).toString()).toBe(PAGE)
  })

  it('sends the render when storing it fails', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(storage, 'setItemRaw').mockRejectedValueOnce(new Error('disk full'))

    const response = await get('/blog/no-space')
    expect(response.status).toBe(200)
    expect(brotliDecompressSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(PAGE)
    expect((await get('/blog/no-space')).headers.get('x-cache')).toBe('MISS')
  })

  it('does not store cookies, errors, or paths outside the cache', async () => {
    await get('/blog/cookie')
    await get('/blog/cookie')
    await get('/blog/missing')
    await get('/blog/missing')
    const about = await get('/about')

    expect(renders).toBe(4)
    expect(about.headers.get('x-cache')).toBeNull()
    expect(items.size).toBe(0)
  })

  it('serves unlisted query params from the path entry but never stores them', async () => {
    await get('/blog/tracked?utm=x')
    expect(items.size).toBe(0)

    await get('/blog/tracked')
    const variant = await get('/blog/tracked?utm=y')
    expect(variant.headers.get('x-cache')).toBe('HIT')
    expect(renders).toBe(2)
  })

  it('serves a miss that arrives during a background revalidation from its result', async () => {
    await createApp({ rule: { maxAge: 60, staleMaxAge: 10 } })
    await get('/blog/race')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 65_000)
    expect((await get('/blog/race')).headers.get('x-cache')).toBe('STALE')

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 20_000)
    const during = await get('/blog/race')
    expect(during.headers.get('x-cache')).toBe('MISS')
    expect(renders).toBe(2)
  })

  it('renders concurrent misses once', async () => {
    const responses = await Promise.all(Array.from({ length: 5 }, () => get('/blog/popular-post')))

    expect(responses.every(response => response.status === 200)).toBe(true)
    expect(renders).toBe(1)
  })

  it('serves stale pages and re-renders them in the background', async () => {
    await get('/blog/stale')
    body = `${PAGE}<!-- v2 -->`
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now + 61_000)

    const stale = await get('/blog/stale')
    expect(stale.headers.get('x-cache')).toBe('STALE')
    expect(brotliDecompressSync(new Uint8Array(await stale.arrayBuffer())).toString()).toBe(PAGE)

    await vi.waitFor(() => expect(renders).toBe(2))
    vi.spyOn(Date, 'now').mockReturnValue(now + 62_000)
    await vi.waitFor(async () => {
      const fresh = await get('/blog/stale')
      expect(fresh.headers.get('x-cache')).toBe('HIT')
      expect(brotliDecompressSync(new Uint8Array(await fresh.arrayBuffer())).toString()).toContain('v2')
    })
  })

  it('treats a partially written variant as a miss', async () => {
    await get('/blog/partial')
    const key = [...items.keys()].find(name => name.endsWith(':br'))!
    items.set(key, new Uint8Array(3))

    const response = await get('/blog/partial')
    expect(response.headers.get('x-cache')).toBe('MISS')
    expect(renders).toBe(2)
  })

  it('stores only the configured copy and converts for other clients', async () => {
    await createApp({ encodings: ['br'] })
    await get('/blog/onlybr')
    expect([...items.keys()].some(name => name.endsWith(':gz'))).toBe(false)

    const gzipped = await get('/blog/onlybr', { 'accept-encoding': 'gzip' })
    expect(gzipped.headers.get('x-cache')).toBe('HIT')
    expect(gzipped.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await gzipped.arrayBuffer())).toString()).toBe(PAGE)

    const plain = await get('/blog/onlybr', {})
    expect(await plain.text()).toBe(PAGE)

    await createApp({ encodings: ['gzip'] })
    await get('/blog/onlygz', { 'accept-encoding': 'gzip' })
    const both = await get('/blog/onlygz', { 'accept-encoding': 'br, gzip' })
    expect(both.headers.get('content-encoding')).toBe('gzip')

    const brotli = await get('/blog/onlygz', { 'accept-encoding': 'br' })
    expect(brotli.headers.get('content-encoding')).toBe('br')
    expect(brotliDecompressSync(new Uint8Array(await brotli.arrayBuffer())).toString()).toBe(PAGE)
    expect(renders).toBe(1)
  })

  it('limits stale serving with staleMaxAge and sets a storage TTL', async () => {
    await createApp({ rule: { maxAge: 60, staleMaxAge: 30 } })
    await get('/blog/window')
    expect([...ttls.values()].every(ttl => ttl === 90)).toBe(true)
    const now = Date.now()

    vi.spyOn(Date, 'now').mockReturnValue(now + 80_000)
    expect((await get('/blog/window')).headers.get('x-cache')).toBe('STALE')
    await vi.waitFor(() => expect(renders).toBe(2))
    await new Promise(resolve => setTimeout(resolve, 20))

    vi.spyOn(Date, 'now').mockReturnValue(now + 80_000 + 100_000)
    expect((await get('/blog/window')).headers.get('x-cache')).toBe('MISS')
    expect(renders).toBe(3)
  })

  it('waits for a fresh render with staleMaxAge 0', async () => {
    await createApp({ rule: { maxAge: 60, staleMaxAge: 0 } })
    await get('/blog/nostale')
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)

    expect((await get('/blog/nostale')).headers.get('x-cache')).toBe('MISS')
    expect(renders).toBe(2)
  })

  it('drops a stale copy when its re-render is gone', async () => {
    await get('/blog/deleted')
    status = 404
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)

    expect((await get('/blog/deleted')).headers.get('x-cache')).toBe('STALE')
    await vi.waitFor(() => expect(items.size).toBe(0))
    expect((await get('/blog/deleted')).status).toBe(404)
  })

  it('drops a stale copy when its re-render is no longer shareable', async () => {
    await get('/blog/went-private')
    cacheControl = 'private, no-store'
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)

    expect((await get('/blog/went-private')).headers.get('x-cache')).toBe('STALE')
    await vi.waitFor(() => expect(items.size).toBe(0))
    expect((await get('/blog/went-private')).headers.get('x-cache')).toBeNull()
  })

  it('leaves a body that is already encoded alone', async () => {
    const response = await get('/blog/encoded')

    expect(response.headers.get('x-cache')).toBeNull()
    expect(response.headers.get('content-encoding')).toBe('gzip')
    expect(gunzipSync(new Uint8Array(await response.arrayBuffer())).toString()).toBe(PAGE)
    expect(items.size).toBe(0)
  })

  it('keeps a stale copy when its re-render fails with a server error', async () => {
    await get('/blog/flaky')
    status = 500
    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)

    expect((await get('/blog/flaky')).headers.get('x-cache')).toBe('STALE')
    await vi.waitFor(() => expect(renders).toBe(2))
    await new Promise(resolve => setTimeout(resolve, 20))
    expect((await get('/blog/flaky')).headers.get('x-cache')).toBe('STALE')
  })

  it('re-renders outdated entries before sending them with staleMaxAge 0', async () => {
    const { expireCompressedCache } = await import('#src/runtime/compressed-cache')
    await createApp({ rule: { maxAge: 60, staleMaxAge: 0 } })
    await get('/blog/strict')
    await expireCompressedCache({ path: '/blog/strict' })

    expect((await get('/blog/strict')).headers.get('x-cache')).toBe('MISS')
    expect(renders).toBe(2)
  })

  it('renders pages from another build again before sending them', async () => {
    await createApp({ version: 'build-1' })
    await get('/blog/build')
    await createApp({ version: 'build-2', keep: true })
    body = `${PAGE}<!-- build-2 -->`

    const fresh = await get('/blog/build')
    expect(fresh.headers.get('x-cache')).toBe('MISS')
    expect(brotliDecompressSync(new Uint8Array(await fresh.arrayBuffer())).toString()).toContain('build-2')
    expect((await get('/blog/build')).headers.get('x-cache')).toBe('HIT')
  })

  it('keys payloads without the build param when there is no version', async () => {
    await get('/blog/p/_payload.json?_b=one')

    expect((await get('/blog/p/_payload.json?_b=two')).headers.get('x-cache')).toBe('HIT')
    expect((await get('/blog/p/_payload.json')).headers.get('x-cache')).toBe('HIT')
    expect(renders).toBe(1)
  })

  it('keys payloads by build and stores only the running one', async () => {
    await createApp({ version: 'build-1' })
    expect((await get('/blog/p/_payload.json?_b=build-1')).headers.get('x-cache')).toBe('MISS')
    expect((await get('/blog/p/_payload.json')).headers.get('x-cache')).toBe('HIT')

    await createApp({ version: 'build-2', keep: true })
    const old = await get('/blog/p/_payload.json?_b=build-1')
    expect(old.headers.get('x-cache')).toBe('HIT')
    expect(brotliDecompressSync(new Uint8Array(await old.arrayBuffer())).toString()).toContain('"renders":1')
    expect((await get('/blog/p/_payload.json?_b=build-2')).headers.get('x-cache')).toBe('MISS')
    expect((await get('/blog/p/_payload.json?_b=build-2')).headers.get('x-cache')).toBe('HIT')
    expect(renders).toBe(1)

    vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 61_000)
    expect((await get('/blog/p/_payload.json?_b=build-1')).headers.get('x-cache')).toBeNull()
    expect(renders).toBe(2)
  })

  it('never stores payloads for a build that is not running', async () => {
    await createApp({ version: 'build-2' })

    expect((await get('/blog/p/_payload.json?_b=junk')).headers.get('x-cache')).toBeNull()
    expect((await get('/blog/p/_payload.json?_b=junk')).headers.get('x-cache')).toBeNull()
    expect(items.size).toBe(0)
    expect(renders).toBe(2)
  })

  it('keys allowed query params, in any order, and ignores the rest', async () => {
    await createApp({ rule: { maxAge: 60, allowQuery: ['page', 'sort'] } })

    expect((await get('/blog/list?page=2&sort=new')).headers.get('x-cache')).toBe('MISS')
    expect((await get('/blog/list?sort=new&page=2')).headers.get('x-cache')).toBe('HIT')
    expect((await get('/blog/list?page=3')).headers.get('x-cache')).toBe('MISS')
    expect((await get('/blog/list?page=3&utm=x')).headers.get('x-cache')).toBe('HIT')
    expect((await get('/blog/list?page=4&utm=x')).headers.get('x-cache')).toBeNull()
    expect(renders).toBe(3)
  })

  it('skips the cache for requests with a bypass cookie', async () => {
    await createApp({ rule: { maxAge: 60, bypassCookies: ['session'] } })
    await get('/blog/me')

    const loggedIn = await get('/blog/me', { 'accept-encoding': 'br', 'cookie': 'theme=dark; session=abc' })
    expect(loggedIn.headers.get('x-cache')).toBeNull()
    expect((await get('/blog/me', { 'accept-encoding': 'br', 'cookie': 'theme=dark' })).headers.get('x-cache')).toBe('HIT')
    expect(renders).toBe(2)
  })

  it('expires and removes a page together with its payload', async () => {
    const { expireCompressedCache, removeCompressedCache } = await import('#src/runtime/compressed-cache')
    await createApp({ version: 'build-1' })
    await get('/blog/with-data')
    await get('/blog/with-data/_payload.json?_b=build-1')

    expect(await expireCompressedCache({ path: '/blog/with-data' })).toBe(2)
    expect((await get('/blog/with-data/_payload.json?_b=build-1')).headers.get('x-cache')).toBe('STALE')
    await vi.waitFor(() => expect(renders).toBe(3))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(await removeCompressedCache({ path: '/blog/with-data' })).toBe(2)
    expect(items.size).toBe(0)
  })

  it('expires and removes entries by path and by path prefix', async () => {
    const { expireCompressedCache, removeCompressedCache } = await import('#src/runtime/compressed-cache')
    await get('/blog/first')
    await get('/blog/second')
    await get('/docs/intro')

    expect(await expireCompressedCache({ path: '/blog/first' })).toBe(1)
    expect((await get('/blog/first')).headers.get('x-cache')).toBe('STALE')
    expect((await get('/blog/second')).headers.get('x-cache')).toBe('HIT')

    expect(await removeCompressedCache({ pathPrefix: '/blog/' })).toBe(2)
    expect((await get('/blog/second')).headers.get('x-cache')).toBe('MISS')
    expect(await removeCompressedCache({ path: '/blog/missing-page' })).toBe(0)
  })

  it('prunes entries rendered before the given age, by their own render time', async () => {
    const { pruneCompressedCache } = await import('#src/runtime/compressed-cache')
    const now = Date.now()
    vi.spyOn(Date, 'now').mockReturnValue(now - 50_000)
    await get('/blog/old')
    vi.spyOn(Date, 'now').mockReturnValue(now)
    await get('/blog/recent')

    expect(await pruneCompressedCache({ olderThan: 30 })).toBe(1)
    expect([...items.keys()].filter(key => key.endsWith(':meta'))).toHaveLength(1)
    expect((await get('/blog/old')).headers.get('x-cache')).toBe('MISS')
    expect((await get('/blog/recent')).headers.get('x-cache')).toBe('HIT')
    expect(await pruneCompressedCache({ olderThan: 30 })).toBe(0)
  })
})
