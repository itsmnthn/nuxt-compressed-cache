import type { CompressedCacheConfig } from '../compressed-cache'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { defineTask } from 'nitro/task'
import { pruneCompressedCache } from '../server-utils'

/**
 * Reads `cleanup.olderThan`, which arrives as a string from an env override. `0` removes every entry on each run.
 * Unset (`undefined` or `''`) and invalid values prune by expiry, an invalid value also warns.
 *
 * @returns Seconds, or `undefined` to prune by expiry.
 */
export function parseOlderThan(value: unknown): number | undefined {
  if (value === undefined || value === '') {
    return undefined
  }

  // a blank string would read as `0`, which removes everything, so only a written number counts
  const seconds = typeof value === 'number' ? value : typeof value === 'string' && value.trim() ? Number(value) : Number.NaN
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds
  }

  console.warn(`[compressed-cache] ignoring invalid cleanup.olderThan ${JSON.stringify(value)}, pruning by expiry instead`)
  return undefined
}

/** Removes expired entries, or ones older than `cleanup.olderThan`, from the module's configured storage and prefix. */
export default defineTask({
  meta: { name: 'compressed-cache:prune', description: 'Prune expired compressed cache entries' },
  async run() {
    const { cleanup } = useRuntimeConfig().compressedCache as CompressedCacheConfig & { cleanup: { olderThan?: unknown } }
    return { result: await pruneCompressedCache({ olderThan: parseOlderThan(cleanup.olderThan) }) }
  },
})
