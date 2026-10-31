import type { KVMounts, NitroConfig, NitroModule } from 'nitro/types'
import type { CompressedCacheConfig, CompressedCacheRule } from './runtime/compressed-cache.js'
import { randomUUID } from 'node:crypto'
import { fileURLToPath } from 'node:url'

export interface CompressedCacheModuleOptions extends Omit<CompressedCacheConfig, 'storage' | 'version'> {
  /** Name of the Nitro KV mount for entries. Defaults to the only `kv` mount here, otherwise `cache`. */
  storage?: string
  /** Mounts to add, same shape as Nitro's `kv` option, for example `{ pages: { driver: 'fs', base: './.data/pages' } }`. */
  kv?: KVMounts
  /** Treat entries from a previous build as stale, so they re-render after a deploy that keeps the storage. */
  invalidateOnBuild?: boolean
  /** Enable scheduled pruning, daily at 04:00 by default, of entries past their route rule's `maxAge` and `staleMaxAge`. */
  cleanup?: boolean | {
    /** Cron expression for Nitro's task runner. */
    schedule?: string
    /** Remove entries rendered more than this many seconds ago, instead of when they expire. */
    olderThan?: number
  }
}

export const defaults = {
  prefix: 'compressed-cache',
  brotliQuality: 6,
  gzipLevel: 6,
  statusHeader: 'x-cache',
  stripQuery: ['utm_*', 'fbclid', 'gclid', 'ref'],
  invalidateOnBuild: true,
  cleanup: false,
} satisfies CompressedCacheModuleOptions

/** Set apart from `defaults`, Nuxt merges those by concatenating arrays, so a chosen list would keep every default. */
const DEFAULT_ENCODINGS: NonNullable<CompressedCacheModuleOptions['encodings']> = ['br', 'gzip']

/** Absolute path of a file in the runtime directory. */
function runtimePath(file: string): string {
  return fileURLToPath(new URL(`./runtime/${file}`, import.meta.url))
}

/**
 * Writes the KV mount, runtime config and cleanup task into a Nitro config, shared by both entry points.
 * `nitro` and `runtimeConfig` are mutated, Nuxt keeps its runtime config apart from its Nitro options.
 */
export function configureCompressedCache({ nitro, runtimeConfig, buildId, options: { storage, kv, encodings = DEFAULT_ENCODINGS, invalidateOnBuild, cleanup, ...options } }: {
  nitro: Pick<NitroConfig, 'kv' | 'experimental' | 'tasks' | 'scheduledTasks'>
  runtimeConfig: Record<string, unknown>
  buildId?: string
  options: CompressedCacheModuleOptions
}): void {
  const { schedule = '0 4 * * *', olderThan } = typeof cleanup === 'object' ? cleanup : {}

  const mounts = Object.keys(kv ?? {})
  if (!storage && mounts.length > 1) {
    throw new Error('[compressed-cache] `storage` has to name the mount for entries when `kv` has several')
  }
  const mount = storage ?? mounts[0] ?? 'cache'
  if (kv) {
    nitro.kv = { ...nitro.kv, ...kv }
  }
  // generated runtime config types come from the first run, so they cannot follow optional options
  runtimeConfig.compressedCache = {
    ...options,
    encodings,
    storage: mount,
    version: invalidateOnBuild ? buildId : undefined,
    // runtime config turns an `undefined` value into `''`, so an unset `olderThan` is left out
    cleanup: cleanup ? (olderThan === undefined ? {} : { olderThan }) : false,
  }

  if (cleanup) {
    nitro.experimental ||= {}
    nitro.experimental.tasks = true
    nitro.tasks ||= {}
    nitro.tasks['compressed-cache:prune'] = { handler: runtimePath('tasks/prune') }
    nitro.scheduledTasks ||= {}
    const scheduled = nitro.scheduledTasks[schedule]
    nitro.scheduledTasks[schedule] = [...new Set([...(Array.isArray(scheduled) ? scheduled : scheduled ? [scheduled] : []), 'compressed-cache:prune'])]
  }
}

/**
 * Nitro module that serves `compressedCache` route rules from pre-compressed copies, for an app without Nuxt:
 * `modules: [compressedCache({ cleanup: true })]`. There is no build id, so each build generates its own.
 */
export default function compressedCache(options: CompressedCacheModuleOptions = {}): NitroModule {
  return {
    name: 'nuxt-compressed-cache',
    setup(nitro) {
      configureCompressedCache({
        nitro: nitro.options,
        runtimeConfig: nitro.options.runtimeConfig,
        buildId: randomUUID(),
        options: { ...defaults, ...options, stripQuery: [...defaults.stripQuery, ...(options.stripQuery ?? [])] },
      })
      nitro.options.handlers.push({ route: '/**', middleware: true, handler: runtimePath('middleware') })
      // published as files in `node_modules`, which Nitro leaves external, but they import Nitro's virtual runtime
      if (nitro.options.noExternals !== true) {
        nitro.options.noExternals = [...(nitro.options.noExternals || []), runtimePath('')]
      }
    },
  }
}

declare module 'nitro/types' {
  interface RouteRules {
    compressedCache?: CompressedCacheRule
  }
  interface RouteRuleConfig {
    /** Serve this route from pre-compressed copies, re-rendered in the background after `maxAge` seconds. */
    compressedCache?: CompressedCacheRule
  }
}
