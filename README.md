# nuxt-compressed-cache

Serve Nuxt and Nitro pages from pre-compressed cached copies.

Nitro's `swr` cache stores each response as a JSON entry and sends it uncompressed, so every hit parses the
entry, and the page is compressed again on every hit by whatever sits in front (a proxy or CDN), or goes out
uncompressed. This module stores rendered pages already compressed with brotli and gzip, then sends the stored
bytes as they are. A hit reads a small metadata entry and the compressed bytes. Compression runs once per
render instead of once per request.

- Stale-while-revalidate, configured per route like Nitro's `swr`
- Concurrent misses render once (per server process)
- Content negotiation by `Accept-Encoding` weights, including clients that accept no compression
- `ETag` and `304 Not Modified`
- Caches the `_payload.json` Nuxt fetches on client-side navigation, per build, via `isr: true` ([Payloads](#payloads))
- Pages from an older build are rendered again after a deploy
- Helpers to expire, remove and prune entries

> Requires Nitro `3.0.261029-rc` or newer, either through Nuxt 5 (`5.0.0-2610292241-bc2bef7` or newer) or on its own,
> deployed as a Node server (VPS, Docker, Coolify…). See [Deployment](#deployment).

## Why

When your own server renders and serves every request, each cache hit still costs work. Nitro's `swr` reads a
JSON entry, parses it and sends the page uncompressed. Then either your proxy compresses the same page again on
every hit, a CDN does it at the edge, or it goes out uncompressed. This module moves that work to render time:

- **Less work per hit.** A hit reads the stored bytes and sends them as they are. The page itself is never
  parsed or compressed on a hit.
- **Smaller responses from your server.** Pages leave your server compressed, even when nothing in front of it
  compresses. Compression is paid once per render, so a higher brotli quality costs nothing per hit.
- **Smaller storage.** Entries are stored compressed.
- **Client-side navigation is cached too.** Nuxt's `_payload.json` is cached per build, without also turning on
  Nitro's cache.
- **Safe across deploys.** After a deploy, pages stored by the previous build render again before they are
  sent.

### You might not need this

This is a niche module. Use Nitro's `swr` or `isr` instead, or nothing at all, if:

- you deploy to Vercel, Netlify, Cloudflare or another serverless or edge platform. They provide their own
  caching and compression, and the module isn't built for them;
- a CDN in front of your server already caches your HTML;
- your pages can be prerendered, so there's nothing to render at request time;
- your traffic is low or your pages are cheap to render, so `swr` is fast enough;
- your pages differ per visitor by something other than a cookie (such as language or user agent), since every
  visitor gets the same copy.

## Install

There are two entry points with the same options: a Nuxt module, and a Nitro module for an app without Nuxt.

### Nuxt

```bash
pnpm add nuxt-compressed-cache
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  modules: ['nuxt-compressed-cache'],
  routeRules: {
    '/': { compressedCache: { maxAge: 60 * 60 } },
    '/blog/**': { compressedCache: { maxAge: 60 * 60 * 24 } },
  },
})
```

Responses served by the cache carry an `x-cache` header: `HIT`, `STALE` or `MISS`. Responses it passes
through without storing (an error, a cookie, a bypassed request) don't.

The cache does nothing in development or while prerendering.

### Nitro

```bash
pnpm add nitro unstorage nuxt-compressed-cache
```

```ts
// nitro.config.ts
import { defineConfig } from 'nitro/config'
import compressedCache from 'nuxt-compressed-cache/nitro'

export default defineConfig({
  modules: [compressedCache({ cleanup: true })],
  routeRules: {
    '/blog/**': { compressedCache: { maxAge: 60 * 60 * 24 } },
  },
})
```

It is a [Nitro module](https://nitro.build/config/features#modules) rather than a plain middleware, because it also has
to set the runtime config, the KV mount and the cleanup task, and bundle the middleware into your server. Everything
below applies, except that:

- options are passed to `compressedCache()` instead of a `compressedCache` config key;
- `unstorage` has to be installed in your app, Nitro no longer includes it;
- [server helpers](#server-helpers) are imported from `nuxt-compressed-cache/server-utils`;
- `invalidateOnBuild` uses an id generated for each build, as Nitro has no build id;
- [payloads](#payloads) don't apply, and the module doesn't add `isr`.

## Storage

By default, entries go to Nitro's `cache` KV mount. If that mount isn't backed by persistent storage in
production, entries are lost on every restart. To use a dedicated persistent mount:

```ts
export default defineNuxtConfig({
  compressedCache: {
    // same shape as Nitro's `kv` option, the key is the mount name
    kv: { pages: { driver: 'fs', base: './.data/pages' } },
  },
})
```

A mount here replaces one of the same name in Nitro's `kv` option, so pick another name to keep both. If you pass
several mounts, set `storage` to the one that holds the entries.

To use a mount you configured yourself in Nitro's `kv` option, pass its name, for example `storage: 'redis'`.

## Route rule

```ts
export default defineNuxtConfig({
  routeRules: {
    '/products/**': {
      compressedCache: {
        maxAge: 3600,
        staleMaxAge: 86400,
        allowQuery: ['page'],
        stripQuery: ['tab'],
        bypassCookies: ['session'],
      },
    },
  },
})
```

| Option | Description |
| --- | --- |
| `maxAge` | Seconds a copy is fresh. |
| `staleMaxAge` | Seconds a copy may still be served after `maxAge` while it re-renders in the background. Unset serves stale copies until they are replaced. `0` always waits for a fresh render. When set, entries also get a storage TTL of `maxAge + staleMaxAge`, on drivers that support one. |
| `allowQuery` | Query params that get their own entry, for example `page`. |
| `stripQuery` | Query params that don't change the page, added to the module's `stripQuery`. They are dropped from the key, so a request with one gets an existing entry, but a miss isn't stored. A trailing `*` matches by prefix. |
| `bypassCookies` | Requests carrying any of these cookies skip the cache, for example a session cookie. |

### Query params

A request with a query param that is in neither `allowQuery` nor `stripQuery` skips the cache: no lookup and no
store, so a search like `?q=` always renders fresh. The first request with each such param name logs which option to
add it to. Stripped params are never stored because the rendered page can echo the query, in links or a canonical URL.

> [!IMPORTANT]
> Migrating to 0.1.3: requests with unlisted query params used to get the stored copy, now they skip the cache.
> List params that select content in `allowQuery`, and ones that don't change the page in `stripQuery`.

## Module options

| Option | Default | Description |
| --- | --- | --- |
| `storage` | `'cache'` | Name of the Nitro KV mount for entries. Defaults to the only mount in `kv` when you set one. |
| `kv` | | Mounts to add, same shape as Nitro's `kv` option. The key is the mount name. |
| `prefix` | `'compressed-cache'` | Key prefix inside the storage mount. |
| `encodings` | `['br', 'gzip']` | Copies to store. Storing only `br` drops the gzip copy, and clients that don't accept brotli are then converted on the fly. Clients that accept no compression always get a copy decompressed on the fly. |
| `brotliQuality` | `6` | Brotli quality, used once per render. |
| `gzipLevel` | `6` | Gzip level, used once per render. |
| `stripQuery` | `['utm_*', 'fbclid', 'gclid', 'ref']` | Query params every rule drops from the key (see [Query params](#query-params)). A list you set is added to these. |
| `statusHeader` | `'x-cache'` | Header that reports `HIT`, `STALE` or `MISS`. `false` omits it. |
| `invalidateOnBuild` | `true` | Tie entries to the build. After a deploy that keeps the storage, pages render again before they are sent, and payloads are kept per build (see [Payloads](#payloads)). |
| `cleanup` | `false` | Enable Nitro's scheduled pruning task. `true` runs daily at 04:00 and removes expired entries (see [Server helpers](#server-helpers)). An object can override `schedule` (cron) and set `olderThan` (seconds) to remove by age instead, where `0` removes every entry on each run. An invalid `olderThan` logs a warning and falls back to expiry. |

## Server helpers

These are auto-imported in Nuxt server code. In a plain Nitro app, import them from
`nuxt-compressed-cache/server-utils`. A `path` also covers that page's `_payload.json`.

```ts
// mark entries stale: each is served stale while it re-renders (re-rendered first when `staleMaxAge` is 0)
await expireCompressedCache({ path: '/blog/my-post' })
await expireCompressedCache({ pathPrefix: '/blog/' })

// delete entries: the next request renders fresh
await removeCompressedCache({ path: '/blog/my-post' })

// delete expired entries: past `maxAge` (plus `staleMaxAge` when set) of their page's current route rule,
// and entries whose page no longer has a `compressedCache` rule
await pruneCompressedCache()

// or delete entries rendered more than `olderThan` seconds ago, whatever their rule
await pruneCompressedCache({ olderThan: 7 * 24 * 60 * 60 })

// or delete every entry
await pruneCompressedCache({ olderThan: 0 })
```

Without `staleMaxAge`, a stale copy is served until a visit replaces it, so pruning only removes pages nobody
has visited since they expired. Their next visitor waits for a render instead of getting the stale copy.

Storage drivers without a TTL (such as `fs`) never drop entries on their own. Enable the built-in cleanup
task with `compressedCache: { cleanup: true }`, which runs `pruneCompressedCache()` daily at 04:00, or
customize it:

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  compressedCache: {
    cleanup: {
      schedule: '0 */6 * * *',
      // remove by age instead of expiry
      olderThan: 7 * 24 * 60 * 60,
    },
  },
})
```

Cleanup is disabled by default. When enabled, the module enables Nitro tasks, registers
`compressed-cache:prune` and adds its schedule alongside existing tasks. It uses the configured storage and
prefix, removing each pruned entry's metadata and compressed copies. Schedules use the server's timezone.

The built-in task only prunes. For more control, such as clearing the cache when the disk is almost full,
leave `cleanup` off and call `pruneCompressedCache` from your own task:

```ts
// server/tasks/compressed-cache/prune.ts
import { defineTask } from 'nitro/task'

export default defineTask({
  meta: { name: 'compressed-cache:prune' },
  async run() {
    return { result: await pruneCompressedCache() }
  },
})
```

```ts
// nuxt.config.ts
export default defineNuxtConfig({
  nitro: {
    experimental: { tasks: true },
    scheduledTasks: { '0 4 * * *': 'compressed-cache:prune' },
  },
})
```

## What gets cached

A response is stored only when all of these are true:

- it is a `GET` with status `200`;
- it is HTML or JSON;
- it has no `Set-Cookie` header;
- its `Cache-Control` is not `no-store` or `private`;
- it isn't already encoded (`Content-Encoding`).

When a background re-render can't be stored (a `404`, a redirect, `private`, `no-store`, a cookie), the stored
copy is removed. A server error (`5xx`) keeps it, so a short outage doesn't empty the cache.

> [!WARNING]
> There are no per-header variants. Every visitor gets the same stored copy, whatever their `Accept-Language`, 
> user agent or cookies. Don't cache pages that render differently per visitor, or list the cookie that changes 
> them in `bypassCookies`.

## Payloads

A direct visit gets the cached HTML, with the page's data inlined. On client-side navigation, Nuxt fetches
`<page>/_payload.json?_b=<build id>` instead, which is cached the same way.

At runtime, Nuxt only serves `_payload.json` on routes it sees as cached, through an `isr` or `cache` rule.
`cache` would also turn on Nitro's own cache, so on Node server presets the module adds `isr: true` to every
`compressedCache` route instead, which those presets ignore. A route that sets `isr` itself keeps its value.

Payloads are kept per build, like the `_b` param Nuxt adds to them:

| Request | Served from | Stored |
| --- | --- | --- |
| `_b` is the running build, or no `_b` | The running build's entry | Yes |
| `_b` is an older build | That build's entry while it is fresh, so an open tab keeps the data its code expects | Never |
| Any other `_b` | Rendered without the cache | Never |

## Deployment

The module is built for long-running Node servers: a VPS, Docker or a platform like Coolify, with a `node-*`,
`bun` or `deno-server` preset. It relies on:

- `node:zlib` and `node:crypto`;
- a long-running process, which merges concurrent renders in memory (per process) and re-renders in the
  background after responding;
- persistent storage for the entries.

On other presets (serverless and edge platforms such as Vercel, Netlify and Cloudflare), the module doesn't add
`isr`, because there it can mean something else (on Vercel it turns on Vercel's own cache). It logs a warning
instead, and pages there get no `_payload.json` for client-side navigation unless you set `isr` or `cache`
yourself.

## Development

```bash
pnpm install
pnpm dev:prepare
pnpm dev        # playground
pnpm test       # unit and e2e tests
pnpm test:types
pnpm lint
```

## License

[MIT](./LICENSE)
