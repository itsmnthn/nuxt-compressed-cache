import type { Nuxt, NuxtConfig } from 'nuxt/schema'
import type { CompressedCacheModuleOptions } from '#src/module'
import { fileURLToPath } from 'node:url'
import { loadNuxt } from 'nuxt/kit'
import { afterEach, describe, expect, it } from 'vitest'
import CompressedCache from '#src/module'

describe('module configuration', () => {
  let nuxt: Nuxt | undefined

  async function configure({ cleanup, storage, kv, encodings, nitro, compressedCache }: {
    cleanup?: CompressedCacheModuleOptions['cleanup']
    storage?: CompressedCacheModuleOptions['storage']
    kv?: CompressedCacheModuleOptions['kv']
    encodings?: CompressedCacheModuleOptions['encodings']
    nitro?: NuxtConfig['nitro']
    compressedCache?: CompressedCacheModuleOptions
  } = {}) {
    nuxt = await loadNuxt({
      cwd: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
      ready: false,
      overrides: { modules: [], nitro },
    })
    const instance = nuxt
    // the fixture's own options would merge into every case
    Object.assign(instance.options, { compressedCache })
    await instance.runWithContext(() => CompressedCache({ cleanup, storage, kv, encodings }, instance))
    return instance.options
  }

  afterEach(async () => {
    await nuxt?.close()
  })

  it('mounts `kv` under the given name, not through the deprecated `storage` option', async () => {
    const options = await configure({ kv: { pages: { driver: 'fs', base: './.data/pages' } }, nitro: { kv: { other: { driver: 'memory' } } } })

    expect(options.nitro.kv).toEqual({ other: { driver: 'memory' }, pages: { driver: 'fs', base: './.data/pages' } })
    expect(options.nitro.storage).toBeUndefined()
    expect(options.runtimeConfig.compressedCache).toMatchObject({ storage: 'pages' })
    expect(options.runtimeConfig.compressedCache).not.toHaveProperty('kv')
  })

  it('replaces a Nitro mount of the same name', async () => {
    const options = await configure({ kv: { pages: { driver: 'fs', base: './.data/pages' } }, nitro: { kv: { pages: { driver: 'memory' } } } })

    expect(options.nitro.kv).toEqual({ pages: { driver: 'fs', base: './.data/pages' } })
  })

  it('needs `storage` to pick between several `kv` mounts', async () => {
    const kv = { pages: { driver: 'memory' }, other: { driver: 'memory' } } as const

    await expect(configure({ kv })).rejects.toThrow('`storage` has to name the mount')
    await nuxt?.close()

    const options = await configure({ kv, storage: 'other' })
    expect(options.runtimeConfig.compressedCache).toMatchObject({ storage: 'other' })
  })

  it.each([
    { encodings: ['br'] },
    { encodings: ['gzip'] },
  ] as const)('stores only the chosen encodings: $encodings', async ({ encodings }) => {
    const inline = await configure({ encodings: [...encodings] })
    expect((inline.runtimeConfig.compressedCache as { encodings: string[] }).encodings).toEqual(encodings)
    await nuxt?.close()

    const configKey = await configure({ compressedCache: { encodings: [...encodings] } })
    expect((configKey.runtimeConfig.compressedCache as { encodings: string[] }).encodings).toEqual(encodings)
  })

  it('stores both encodings by default', async () => {
    const options = await configure()

    expect((options.runtimeConfig.compressedCache as { encodings: string[] }).encodings).toEqual(['br', 'gzip'])
  })

  it('leaves the `kv` option alone for a mount name', async () => {
    const options = await configure({ storage: 'cache' })

    expect(options.nitro.kv).toBeUndefined()
    expect(options.runtimeConfig.compressedCache).toMatchObject({ storage: 'cache' })
  })

  it.each([undefined, false])('leaves Nitro tasks untouched when cleanup is %s', async (cleanup) => {
    const options = await configure({ cleanup })

    expect(options.nitro.experimental?.tasks).not.toBe(true)
    expect(options.nitro.tasks?.['compressed-cache:prune']).toBeUndefined()
    expect(options.nitro.scheduledTasks).toBeUndefined()
    expect(options.runtimeConfig.compressedCache).toMatchObject({ cleanup: false })
  })

  it('registers daily cleanup by expiry when enabled', async () => {
    const options = await configure({ cleanup: true })

    expect(options.nitro.experimental?.tasks).toBe(true)
    expect(options.nitro.tasks?.['compressed-cache:prune']?.handler).toContain('/runtime/tasks/prune')
    expect(options.nitro.scheduledTasks?.['0 4 * * *']).toEqual(['compressed-cache:prune'])
    expect((options.runtimeConfig.compressedCache as { cleanup?: unknown }).cleanup).toStrictEqual({})
  })

  it('keeps the default schedule with a custom short retention', async () => {
    const options = await configure({ cleanup: { olderThan: 1 } })

    expect(options.nitro.scheduledTasks?.['0 4 * * *']).toEqual(['compressed-cache:prune'])
    expect(options.runtimeConfig.compressedCache).toMatchObject({ cleanup: { olderThan: 1 } })
  })

  it.each([
    { scheduled: 'existing:task' },
    { scheduled: ['existing:task', 'compressed-cache:prune'] },
  ])('preserves existing tasks at the cleanup schedule: $scheduled', async ({ scheduled }) => {
    const options = await configure({
      cleanup: { schedule: '* * * * *' },
      nitro: {
        experimental: { tasks: true },
        tasks: { 'existing:task': { handler: '/existing-task.ts' } },
        scheduledTasks: { '* * * * *': scheduled, '0 * * * *': 'another:task' },
      },
    })

    expect(options.nitro.tasks?.['existing:task']).toEqual({ handler: '/existing-task.ts' })
    expect(options.nitro.scheduledTasks).toEqual({
      '* * * * *': ['existing:task', 'compressed-cache:prune'],
      '0 * * * *': 'another:task',
    })
    expect((options.runtimeConfig.compressedCache as { cleanup?: unknown }).cleanup).toStrictEqual({})
  })
})
