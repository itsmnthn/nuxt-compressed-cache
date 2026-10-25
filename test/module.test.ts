import type { Nuxt, NuxtConfig } from 'nuxt/schema'
import type { CompressedCacheModuleOptions } from '#src/module'
import { fileURLToPath } from 'node:url'
import { loadNuxt } from 'nuxt/kit'
import { afterEach, describe, expect, it } from 'vitest'
import CompressedCache from '#src/module'

describe('cleanup configuration', () => {
  let nuxt: Nuxt | undefined

  async function configure({ cleanup, nitro }: {
    cleanup?: CompressedCacheModuleOptions['cleanup']
    nitro?: NuxtConfig['nitro']
  } = {}) {
    nuxt = await loadNuxt({
      cwd: fileURLToPath(new URL('./fixtures/basic', import.meta.url)),
      ready: false,
      overrides: { modules: [], nitro },
    })
    const instance = nuxt
    await instance.runWithContext(() => CompressedCache({ cleanup }, instance))
    return instance.options
  }

  afterEach(async () => {
    await nuxt?.close()
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
    expect((options.runtimeConfig.compressedCache as { cleanup?: unknown }).cleanup).toEqual({})
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
    expect((options.runtimeConfig.compressedCache as { cleanup?: unknown }).cleanup).toEqual({})
  })
})
