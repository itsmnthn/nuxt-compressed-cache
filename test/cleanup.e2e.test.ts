import { fileURLToPath } from 'node:url'
import { fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('scheduled cleanup in a built app', async () => {
  await setup({
    rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
    // Nitro skips scheduling when Vitest's TEST flag is set.
    env: { TEST: '' },
    nuxtConfig: {
      compressedCache: {
        prefix: 'cleanup-test',
        cleanup: { schedule: '* * * * * *', olderThan: 2 },
      },
    },
  })

  it('automatically removes old pages and payloads while keeping recent entries', async () => {
    expect((await fetch('/blog/cleanup-old')).headers.get('x-cache')).toBe('MISS')
    expect((await fetch('/blog/cleanup-old/_payload.json')).headers.get('x-cache')).toBe('MISS')
    expect((await fetch('/blog/cleanup-old')).headers.get('x-cache')).toBe('HIT')

    await new Promise(resolve => setTimeout(resolve, 2100))
    expect((await fetch('/blog/cleanup-fresh')).headers.get('x-cache')).toBe('MISS')

    await expect.poll(async () => {
      const responses = await Promise.all([
        fetch('/blog/cleanup-old', { method: 'HEAD' }),
        fetch('/blog/cleanup-old/_payload.json', { method: 'HEAD' }),
      ])
      return responses.map(response => response.headers.get('x-cache'))
    }, { timeout: 3000 }).toEqual([null, null])

    expect((await fetch('/blog/cleanup-fresh')).headers.get('x-cache')).toBe('HIT')
    expect((await fetch('/blog/cleanup-old')).headers.get('x-cache')).toBe('MISS')
    expect((await fetch('/blog/cleanup-old/_payload.json')).headers.get('x-cache')).toBe('MISS')
  })
})
