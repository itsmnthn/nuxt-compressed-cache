import { defineHandler } from 'nitro/h3'

export default defineHandler((event) => {
  event.res.headers.set('content-type', 'text/html')
  return `<h1>${event.url.pathname}</h1>${'plain nitro '.repeat(200)}`
})
