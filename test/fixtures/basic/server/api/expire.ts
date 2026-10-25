import { defineHandler, getQuery } from 'nitro/h3'

export default defineHandler(event => expireCompressedCache({ path: String(getQuery(event).path) }))
