import type { CompressedCacheConfig } from './compressed-cache'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { expireCompressedCache as expire, pruneCompressedCache as prune, removeCompressedCache as remove } from './compressed-cache'

type Target = { path: string } | { pathPrefix: string }

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
 * Deletes entries rendered more than `olderThan` seconds ago, on any storage driver.
 * Call it from a scheduled task, for example `pruneCompressedCache({ olderThan: 40 * 24 * 60 * 60 })`.
 *
 * @returns How many entries were removed.
 */
export function pruneCompressedCache({ olderThan }: { olderThan: number }): Promise<number> {
  return prune({ ...location(), olderThan })
}
