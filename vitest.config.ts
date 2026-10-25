import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    exclude: ['test/fixtures/**'],
    // e2e builds a Nuxt app, give it time
    testTimeout: 120_000,
    hookTimeout: 300_000,
  },
})
