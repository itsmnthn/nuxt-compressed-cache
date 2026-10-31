import type { Nitro, NitroConfig } from 'nitro/types'
import type { CompressedCacheModuleOptions } from '#src/nitro'
import { describe, expect, it } from 'vitest'
import compressedCache from '#src/nitro'

describe('nitro module', () => {
  function setup({ options, config }: { options?: CompressedCacheModuleOptions, config?: NitroConfig } = {}) {
    const nitroOptions = { runtimeConfig: {}, handlers: [], ...config }
    void compressedCache(options).setup({ options: nitroOptions } as unknown as Nitro)
    return nitroOptions as NitroConfig & { runtimeConfig: { compressedCache: Record<string, unknown> }, handlers: { handler: string }[] }
  }

  it('registers the middleware and bundles the runtime', () => {
    const { handlers, noExternals } = setup()

    expect(handlers).toEqual([expect.objectContaining({ route: '/**', middleware: true, handler: expect.stringContaining('/runtime/middleware') })])
    expect(noExternals).toEqual([expect.stringContaining('/runtime')])
  })

  it('keeps a Nitro app that already bundles everything', () => {
    expect(setup({ config: { noExternals: true } }).noExternals).toBe(true)
  })

  it('defaults to the `cache` KV mount without adding one', () => {
    const { kv, runtimeConfig } = setup()

    expect(kv).toBeUndefined()
    expect(runtimeConfig.compressedCache).toMatchObject({ storage: 'cache', prefix: 'compressed-cache', cleanup: false })
  })

  it('mounts `kv` under the given name, keeping other mounts', () => {
    const { kv, storage, runtimeConfig } = setup({
      options: { kv: { pages: { driver: 'fs', base: './.data/pages' } } },
      config: { kv: { other: { driver: 'memory' } } },
    })

    expect(kv).toEqual({ other: { driver: 'memory' }, pages: { driver: 'fs', base: './.data/pages' } })
    expect(storage).toBeUndefined()
    expect(runtimeConfig.compressedCache.storage).toBe('pages')
    expect(runtimeConfig.compressedCache).not.toHaveProperty('kv')
  })

  it('uses a named mount without adding one', () => {
    const { kv, runtimeConfig } = setup({ options: { storage: 'redis' } })

    expect(kv).toBeUndefined()
    expect(runtimeConfig.compressedCache.storage).toBe('redis')
  })

  it('stores the chosen encodings, both by default', () => {
    expect(setup().runtimeConfig.compressedCache.encodings).toEqual(['br', 'gzip'])
    expect(setup({ options: { encodings: ['br'] } }).runtimeConfig.compressedCache.encodings).toEqual(['br'])
  })

  it('generates a build id unless told not to invalidate on build', () => {
    expect(setup().runtimeConfig.compressedCache.version).toEqual(expect.any(String))
    expect(setup({ options: { invalidateOnBuild: false } }).runtimeConfig.compressedCache.version).toBeUndefined()
  })

  it('adds to the default stripped query params', () => {
    const { stripQuery } = setup({ options: { stripQuery: ['tab'] } }).runtimeConfig.compressedCache

    expect(stripQuery).toEqual(['utm_*', 'fbclid', 'gclid', 'ref', 'tab'])
  })

  it('registers the cleanup task when enabled', () => {
    const { experimental, tasks, scheduledTasks } = setup({ options: { cleanup: true } })

    expect(experimental?.tasks).toBe(true)
    expect(tasks?.['compressed-cache:prune']?.handler).toContain('/runtime/tasks/prune')
    expect(scheduledTasks?.['0 4 * * *']).toEqual(['compressed-cache:prune'])
  })
})
