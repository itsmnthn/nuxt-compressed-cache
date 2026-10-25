import type { CompressedCacheConfig, CompressedCacheRule } from './compressed-cache'
import { getRouteRules } from 'nitro/app'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { expireCompressedCache as expire, pruneCompressedCache as prune, removeCompressedCache as remove } from './compressed-cache'

type Target = { path: string } | { pathPrefix: string }

/** The `compressedCache` route rule of a page pathname, from the app's current route rules. */
export function compressedCacheRule({ pathname }: { pathname: string }): CompressedCacheRule | undefined {
  return getRouteRules('GET', pathname).routeRules.compressedCache
}

function location() {
  const { storage, prefix } = useRuntimeConfig().compressedCache as CompressedCacheConfig
  return { storage, prefix }
}

/**
 * Marks cached copies stale, each is served once more while it re-renders in the background.
 * `{ path: '/blog/post' }` for one page or `{ pathPrefix: '/blog/' }` for a section.
 *
 * @returns How many entries were expired.
 */
export function expireCompressedCache(target: Target): Promise<number> {
  return expire({ ...location(), ...target })
}

/**
 * Deletes cached copies, the next request renders fresh.
 * `{ path: '/blog/post' }` for one page or `{ pathPrefix: '/blog/' }` for a section.
 *
 * @returns How many entries were removed.
 */
export function removeCompressedCache(target: Target): Promise<number> {
  return remove({ ...location(), ...target })
}

/**
 * Deletes entries past the `maxAge` (plus `staleMaxAge` when set) of their page's current route rule,
 * and entries whose page no longer has a rule, on any storage driver.
 * Pass `olderThan` (seconds) to delete by render age instead, for example `{ olderThan: 7 * 24 * 60 * 60 }`.
 *
 * @returns How many entries were removed.
 */
export function pruneCompressedCache({ olderThan }: { olderThan?: number } = {}): Promise<number> {
  return olderThan === undefined
    ? prune({ ...location(), rule: compressedCacheRule })
    : prune({ ...location(), olderThan })
}
