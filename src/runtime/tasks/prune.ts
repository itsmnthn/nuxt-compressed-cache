import type { CompressedCacheConfig } from '../compressed-cache'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { defineTask } from 'nitro/task'
import { pruneCompressedCache } from '../server-utils'

/** Removes expired entries, or ones older than `cleanup.olderThan`, from the module's configured storage and prefix. */
export default defineTask({
  meta: { name: 'compressed-cache:prune', description: 'Prune expired compressed cache entries' },
  async run() {
    const { cleanup } = useRuntimeConfig().compressedCache as CompressedCacheConfig & { cleanup: { olderThan?: number } }
    return { result: await pruneCompressedCache({ olderThan: cleanup.olderThan }) }
  },
})
