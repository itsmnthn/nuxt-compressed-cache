import type { CompressedCacheModuleOptions } from './nitro.ts'
import { addServerHandler, addServerImports, addTypeTemplate, createResolver, defineNuxtModule, useLogger } from 'nuxt/kit'
import { configureCompressedCache, defaults } from './nitro.ts'

export type { CompressedCacheModuleOptions }

/** Long-running server presets, the only ones the cache is built for. */
const SERVER_PRESET = /^(?:node-|bun$|deno-server$|nitro-)/

/**
 * Serves `compressedCache` route rules from pre-compressed copies, configured like Nitro's `swr`:
 * `routeRules: { '/blog/**': { compressedCache: { maxAge: 3600 } } }`.
 */
export default defineNuxtModule<CompressedCacheModuleOptions>({
  meta: {
    name: 'nuxt-compressed-cache',
    configKey: 'compressedCache',
    compatibility: { nuxt: '>=5.0.0-2610292241-bc2bef7' },
  },
  defaults,
  setup(options, nuxt) {
    const resolver = createResolver(import.meta.url)

    configureCompressedCache({ nitro: nuxt.options.nitro, runtimeConfig: nuxt.options.runtimeConfig, buildId: nuxt.options.buildId, options })

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
