import type { ChildProcess } from 'node:child_process'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { build, createNitro, prepare } from 'nitro/builder'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import compressedCache from '#src/nitro'

const rootDir = fileURLToPath(new URL('./fixtures/nitro', import.meta.url))
const url = 'http://localhost:4873'

describe('nitro module in a plain Nitro app', () => {
  let server: ChildProcess

  beforeAll(async () => {
    const nitro = await createNitro({
      rootDir,
      serverDir: '.',
      preset: 'node-server',
      compatibilityDate: '2026-10-01',
      modules: [compressedCache({ kv: { pages: { driver: 'memory' } }, cleanup: { schedule: '* * * * * *', olderThan: 1 } })],
      routeRules: { '/page/**': { compressedCache: { maxAge: 60 } } },
    })
    await prepare(nitro)
    await build(nitro)
    await nitro.close()

    // Nitro skips scheduling when Vitest's TEST flag is set.
    server = spawn('node', ['.output/server/index.mjs'], { cwd: rootDir, env: { ...process.env, PORT: '4873', TEST: '' } })
    await vi.waitFor(() => fetch(url), { timeout: 10_000, interval: 100 })
  })

  afterAll(() => {
    server?.kill()
  })

  it('serves a page from its compressed copy', async () => {
    const miss = await fetch(`${url}/page/first`)
    expect(miss.headers.get('x-cache')).toBe('MISS')
    expect(await miss.text()).toContain('/page/first')

    const hit = await fetch(`${url}/page/first`, { headers: { 'accept-encoding': 'br' } })
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('content-encoding')).toBe('br')
    expect(await hit.text()).toContain('/page/first')
  })

  it('prunes through the scheduled task', async () => {
    expect((await fetch(`${url}/page/pruned`)).headers.get('x-cache')).toBe('MISS')

    await expect.poll(async () => (await fetch(`${url}/page/pruned`, { method: 'HEAD' })).headers.get('x-cache'), { timeout: 5000 }).toBeNull()
  })
})
