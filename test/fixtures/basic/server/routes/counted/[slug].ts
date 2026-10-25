import { defineHandler } from 'nitro/h3'

let renders = 0

export default defineHandler((event) => {
  renders++
  event.res.headers.set('content-type', 'text/html;charset=utf-8')
  if (event.url.pathname === '/counted/gone') {
    event.res.status = 404
  }
  return `<html><body>${event.url.pathname} render ${renders}</body></html>`
})
