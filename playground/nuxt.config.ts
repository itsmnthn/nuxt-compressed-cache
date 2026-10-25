export default defineNuxtConfig({
  modules: ['../src/module'],
  compatibilityDate: '2026-10-01',
  routeRules: {
    '/': { compressedCache: { maxAge: 60 } },
  },
  compressedCache: {
    storage: { driver: 'fs', base: './.data/compressed-cache' },
  },
})
