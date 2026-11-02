import { bad, count, createCall, cut, fileText, jsonBody as json, MAX_FILE_BYTES, moreWhen, text } from './shared'

// tessel_apps: Dropbox, read only: the token's scopes allow nothing else. Two fixed hosts; a file's id
// or path travels in a JSON body or header, never in an address.
const API = 'https://api.dropboxapi.com/2'
const CONTENT = 'https://content.dropboxapi.com/2'
const wordsOf = (reason) => (typeof reason?.error_summary === 'string' ? reason.error_summary : typeof reason?.error === 'string' ? reason.error : '')

// A file's id (id:...) or its path (/folder/name), as Dropbox names them.
function fileOf(args) {
  const given = text(args.id, 'id', { required: true, max: 4096 })
  if (!given.startsWith('id:') && !given.startsWith('/')) throw bad('"id" is a file\'s id (id:...) or its path (/folder/name).')
  return given
}
// JSON that fits in a header, as Dropbox asks: nothing but plain characters, so a line break or an
// accent in a file's name cannot do anything but be one.
export const headerJson = (value) => JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`)

export function createDropboxTools({ connections, fetchFn = fetch }) {
  const call = createCall({ connections, provider: 'dropbox', name: 'Dropbox', hosts: ['api.dropboxapi.com', 'content.dropboxapi.com'], fetchFn, wordsOf })
  return {
    dropbox_search: {
      service: 'dropbox',
      async run(args) {
        const found = await call(args.account, `${API}/files/search_v2`, json('POST', { query: text(args.query, 'query', { required: true, max: 1000 }), options: { max_results: count(args.max, 20, 100) } }))
        const files = (found.matches || []).map((m) => m.metadata?.metadata).filter(Boolean)
        return files.length ? `${files.map((f) => `id: ${f.id}\n${f.path_display || f.name} (${f['.tag']}${f.size ? `, ${f.size} bytes` : ''}${f.server_modified ? `, changed ${f.server_modified}` : ''})\n`).join('\n')}${moreWhen(found.has_more)}` : 'No file found.'
      }
    },
    dropbox_read: {
      service: 'dropbox',
      async run(args) {
        const path = fileOf(args)
        const meta = await call(args.account, `${API}/files/get_metadata`, json('POST', { path }))
        if (meta['.tag'] !== 'file') return `"${meta.name}" is a ${meta['.tag']}: it cannot be read here.`
        if (Number(meta.size) > MAX_FILE_BYTES) return `"${meta.name}" is too big to read here (${meta.size} bytes).`
        const got = await fileText(await call(args.account, `${CONTENT}/files/download`, { method: 'POST', headers: { 'dropbox-api-arg': headerJson({ path }) } }, { raw: true }))
        if (!got) return `"${meta.name}" is not text: it cannot be read here.`
        return `${meta.path_display || meta.name}\n\n${cut(got.text)}`
      }
    }
  }
}
