import { fileURLToPath } from 'node:url'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('scheduled cleanup by route rule expiry in a built app', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
    // Nitro skips scheduling when Vitest's TEST flag is set.
    env: { TEST: '' },
    nuxtConfig: {
      routeRules: { '/blog/**': { compressedCache: { maxAge: 1 } } },
      compressedCache: {
        prefix: 'cleanup-expiry-test',
        cleanup: { schedule: '* * * * * *' },
      },
    },
  })

  it('removes entries once their route rule maxAge passes', async () => {
    expect((await fetch('/blog/cleanup-expiring')).headers.get('x-cache')).toBe('MISS')
    expect((await fetch('/blog/cleanup-expiring')).headers.get('x-cache')).toBe('HIT')

    // no requests while waiting, a request for a stale copy would re-render it
    await new Promise(resolve => setTimeout(resolve, 2500))

    // a stale copy that was not pruned would be served as STALE
    expect((await fetch('/blog/cleanup-expiring')).headers.get('x-cache')).toBe('MISS')
  })
})
