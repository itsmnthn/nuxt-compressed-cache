import type { CompressedCacheConfig } from './compressed-cache'
import { getRouteRules } from 'nitro/app'
import { useRuntimeConfig } from 'nitro/runtime-config'
import { defineCompressedCache } from './compressed-cache'

/** Caches every route that has a `compressedCache` route rule, using the module options from runtime config. */
export default defineCompressedCache({
  ...(useRuntimeConfig().compressedCache as CompressedCacheConfig),
  rule: ({ pathname }) => getRouteRules('GET', pathname).routeRules.compressedCache,
})
