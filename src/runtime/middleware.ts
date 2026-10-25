import type { CompressedCacheConfig } from './compressed-cache'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { defineCompressedCache } from './compressed-cache'
import { compressedCacheRule } from './server-utils'

/** Caches every route that has a `compressedCache` route rule, using the module options from runtime config. */
export default defineCompressedCache({
  ...(useRuntimeConfig().compressedCache as CompressedCacheConfig),
  rule: compressedCacheRule,
})
