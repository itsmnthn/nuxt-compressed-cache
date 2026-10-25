import { fileURLToPath } from 'node:url'
import { $fetch, fetch, setup } from '@nuxt/test-utils/e2e'
import { describe, expect, it } from 'vitest'

describe('module in a built app', async () => {
  await setup({ rootDir: fileURLToPath(new URL('./fixtures/basic', import.meta.url)) })

  it('serves a page rendered by Nuxt from its compressed copy', async () => {
    // the test server already requested `/` while waiting for it to start
    const first = await fetch('/', { headers: { 'accept-encoding': 'br' } })
    expect(['MISS', 'HIT']).toContain(first.headers.get('x-cache'))
    expect(first.headers.get('content-encoding')).toBe('br')
    expect(await first.text()).toContain('compressed cache fixture')

    const hit = await fetch('/', { headers: { 'accept-encoding': 'gzip' } })
    expect(hit.headers.get('x-cache')).toBe('HIT')
    expect(hit.headers.get('content-encoding')).toBe('gzip')
  })

  describe('pages', () => {
    it('caches a dynamic page', async () => {
      const miss = await fetch('/blog/hello')
      expect(miss.headers.get('x-cache')).toBe('MISS')
      expect(await miss.text()).toContain('Post hello')

      const hit = await fetch('/blog/hello')
      expect(hit.headers.get('x-cache')).toBe('HIT')
      expect(await hit.text()).toContain('Post hello')
    })

    it('never stores the empty body of a HEAD miss on a page', async () => {
      const head = await fetch('/blog/head-first', { method: 'HEAD' })
      expect(head.status).toBe(200)

      const page = await fetch('/blog/head-first')
      expect(page.headers.get('x-cache')).toBe('MISS')
      expect(await page.text()).toContain('Post head-first')
    })

    it('caches the payload Nuxt extracts for client navigation, per build', async () => {
      const html = await (await fetch('/blog/with-payload')).text()
      expect(html).toContain('"post-with-payload"')
      const buildId = html.match(/buildId:"([^"]+)"/)![1]

      const miss = await fetch(`/blog/with-payload/_payload.json?_b=${buildId}`, { headers: { 'accept-encoding': 'br' } })
      expect(miss.headers.get('x-cache')).toBe('MISS')
      expect(miss.headers.get('content-encoding')).toBe('br')
      expect(miss.headers.get('content-type')).toContain('application/json')
      expect(await miss.text()).toContain('Post with-payload')

      expect((await fetch(`/blog/with-payload/_payload.json?_b=${buildId}`)).headers.get('x-cache')).toBe('HIT')
      expect((await fetch('/blog/with-payload/_payload.json')).headers.get('x-cache')).toBe('HIT')
      expect((await fetch('/blog/with-payload/_payload.json?_b=junk')).headers.get('x-cache')).toBeNull()
    })

    it('caches the payload of an exact route by its page rule', async () => {
      const html = await (await fetch('/')).text()
      const buildId = html.match(/buildId:"([^"]+)"/)![1]

      const miss = await fetch(`/_payload.json?_b=${buildId}`)
      expect(miss.status).toBe(200)
      expect(miss.headers.get('x-cache')).toBe('MISS')
      expect((await fetch(`/_payload.json?_b=${buildId}`)).headers.get('x-cache')).toBe('HIT')
    })

    it('does not store a page that throws a 404', async () => {
      const missing = await fetch('/blog/missing')
      expect(missing.status).toBe(404)
      expect(missing.headers.get('x-cache')).toBeNull()
      expect((await fetch('/blog/missing')).headers.get('x-cache')).toBeNull()
    })
  })

  describe('server routes', () => {
    it('never stores the empty body of a HEAD miss', async () => {
      const head = await fetch('/counted/head-first', { method: 'HEAD' })
      expect(head.status).toBe(200)

      const page = await fetch('/counted/head-first')
      expect(page.headers.get('x-cache')).toBe('MISS')
      expect(await page.text()).toContain('/counted/head-first render')
    })

    it('leaves errors and routes without a rule alone', async () => {
      const gone = await fetch('/counted/gone')
      expect(gone.status).toBe(404)
      expect(gone.headers.get('x-cache')).toBeNull()
      expect(await (await fetch('/counted/gone')).text()).not.toBe(await gone.text())

      const about = await fetch('/about')
      expect(about.headers.get('x-cache')).toBeNull()
    })
  })

  it('auto-imports the server helpers', async () => {
    await $fetch('/counted/expire-me')
    expect(await $fetch('/api/expire', { query: { path: '/counted/expire-me' } })).toBe(1)
    expect((await fetch('/counted/expire-me')).headers.get('x-cache')).toBe('STALE')
  })
})
