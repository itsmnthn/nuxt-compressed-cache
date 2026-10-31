import { defineNuxtConfig } from 'nuxt/config'
import CompressedCache from '#src/module'

export default defineNuxtConfig({
  modules: [CompressedCache],
  compatibilityDate: '2026-10-01',
  routeRules: {
    '/': { compressedCache: { maxAge: 60 } },
    '/blog/**': { compressedCache: { maxAge: 60 } },
    '/counted/**': { compressedCache: { maxAge: 60 } },
  },
  compressedCache: {
    kv: { 'compressed-cache': { driver: 'memory' } },
  },
})
