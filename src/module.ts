import type { CompressedCacheConfig } from './runtime/compressed-cache.js'
import { addServerHandler, addServerImports, addTypeTemplate, createResolver, defineNuxtModule, useLogger } from 'nuxt/kit'

/** Long-running server presets, the only ones the cache is built for. */
const SERVER_PRESET = /^(?:node-|bun$|deno-server$|nitro-)/

export interface CompressedCacheModuleOptions extends Omit<CompressedCacheConfig, 'storage' | 'version'> {
  /** Name of an existing Nitro storage mount, or unstorage driver options mounted as `compressed-cache`. */
  storage?: string | { driver: string, [option: string]: unknown }
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

/**
 * Serves `compressedCache` route rules from pre-compressed copies, configured like Nitro's `swr`:
 * `routeRules: { '/blog/**': { compressedCache: { maxAge: 3600 } } }`.
 */
export default defineNuxtModule<CompressedCacheModuleOptions>({
  meta: {
    name: 'nuxt-compressed-cache',
    configKey: 'compressedCache',
    compatibility: { nuxt: '>=5.0.0-0' },
  },
  defaults: {
    storage: 'cache',
    prefix: 'compressed-cache',
    encodings: ['br', 'gzip'],
    brotliQuality: 6,
    gzipLevel: 6,
    statusHeader: 'x-cache',
    invalidateOnBuild: true,
    cleanup: false,
  },
  setup({ storage, invalidateOnBuild, cleanup, ...options }, nuxt) {
    const resolver = createResolver(import.meta.url)
    const { schedule = '0 4 * * *', olderThan } = typeof cleanup === 'object' ? cleanup : {}

    const mount = typeof storage === 'object' ? 'compressed-cache' : storage ?? 'cache'
    if (typeof storage === 'object') {
      nuxt.options.nitro.storage = { ...nuxt.options.nitro.storage, [mount]: storage }
    }
    // generated runtime config types come from the first run, so they cannot follow optional options
    nuxt.options.runtimeConfig.compressedCache = {
      ...options,
      storage: mount,
      version: invalidateOnBuild ? nuxt.options.buildId : undefined,
      cleanup: cleanup ? { olderThan } : false,
    } as typeof nuxt.options.runtimeConfig.compressedCache

    if (cleanup) {
      const nitro = nuxt.options.nitro
      nitro.experimental ||= {}
      nitro.experimental.tasks = true
      nitro.tasks ||= {}
      nitro.tasks['compressed-cache:prune'] = { handler: resolver.resolve('./runtime/tasks/prune') }
      nitro.scheduledTasks ||= {}
      const scheduled = nitro.scheduledTasks[schedule]
      nitro.scheduledTasks[schedule] = [...new Set([...(Array.isArray(scheduled) ? scheduled : scheduled ? [scheduled] : []), 'compressed-cache:prune'])]
    }

    // Nuxt extracts `_payload.json` for client navigation only on routes it sees as cached (`isr` or `cache`),
    // `cache` would also turn on Nitro's own cache, while server presets ignore `isr`
    nuxt.hook('nitro:init', async (nitro) => {
      const cached = Object.entries(nitro.options.routeRules).filter(([, rules]) => rules.compressedCache && rules.isr === undefined)
      if (!cached.length) {
        return
      }
      if (!SERVER_PRESET.test(nitro.options.preset)) {
        useLogger('nuxt-compressed-cache').warn(`Built for Node servers, the \`${nitro.options.preset}\` preset gets no \`_payload.json\` for client navigation.`)
        return
      }

      await nitro.updateConfig({
        routeRules: { ...nitro.options.routeRules, ...Object.fromEntries(cached.map(([route, rules]) => [route, { ...rules, isr: true }])) },
      })
      nitro.routing.sync()
    })

    addServerHandler({ middleware: true, handler: resolver.resolve('./runtime/middleware') })
    addServerImports(['expireCompressedCache', 'removeCompressedCache', 'pruneCompressedCache']
      .map(name => ({ name, from: resolver.resolve('./runtime/server-utils') })),
    )

    addTypeTemplate({
      filename: 'types/compressed-cache.d.ts',
      getContents: () => `import type { CompressedCacheRule } from ${JSON.stringify(resolver.resolve('./runtime/compressed-cache'))}

declare module 'nitro/types' {
  interface RouteRules {
    compressedCache?: CompressedCacheRule
  }
  interface RouteRuleConfig {
    /** Serve this route from pre-compressed copies, re-rendered in the background after \`maxAge\` seconds. */
    compressedCache?: CompressedCacheRule
  }
}
export {}
`,
    }, { nitro: true, nuxt: true, node: true, shared: true })
  },
})
