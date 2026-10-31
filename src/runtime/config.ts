import type { CompressedCacheRuntimeConfig } from './compressed-cache'
import { useRuntimeConfig } from 'nitro/runtime-config'

/**
 * The module's runtime config. The cast stays here because Nuxt generates the type from one run's values,
 * and declaring the real type on `NitroRuntimeConfig` conflicts with that generated type.
 */
export function useCompressedCacheConfig(): CompressedCacheRuntimeConfig {
  return useRuntimeConfig().compressedCache as CompressedCacheRuntimeConfig
}
