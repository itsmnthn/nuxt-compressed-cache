import { defineNuxtConfig } from 'nuxt/config'

export default defineNuxtConfig({
  modules: ['../src/module'],
  compatibilityDate: '2026-10-01',
  routeRules: {
    '/': { compressedCache: { maxAge: 60 } },
  },
  compressedCache: {
    kv: {
      'compressed-cache': {
        driver: 'fs',
        base: './.data/compressed-cache',
      },
    },
  },
})
