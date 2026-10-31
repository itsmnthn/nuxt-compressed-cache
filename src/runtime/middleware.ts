import { defineCompressedCache } from './compressed-cache'
import { useCompressedCacheConfig } from './config'
import { compressedCacheRule } from './server-utils'

/** Caches every route that has a `compressedCache` route rule, using the module options from runtime config. */
export default defineCompressedCache({
  ...useCompressedCacheConfig(),
  rule: compressedCacheRule,
})
