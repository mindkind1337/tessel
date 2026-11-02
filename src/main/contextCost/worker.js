// Settings > Context counts tokens here, in a utility process the main
// process starts when a count is asked for (workerClient.js): loading a
// tokenizer and counting a large rules file takes tenths of a second that the
// main process (and so every window's messages) never waits for. Nothing here
// goes on the network or to a file: texts in, numbers out.
//   { id, op: 'encoding', encoding, texts }       -> { id, counts }
//     (a shipped OpenAI encoding: o200k_base, o200k_harmony)
//   { id, op: 'tokenizer', loader, items }         -> { id, counts, templates }
//     (a downloaded tokenizer, hfTokenizers.js loaderFor; items: { kind:
//     'text', text } or { kind: 'tools', tools }, counted with the model's
//     chat template when it has one: templates[i] says if it was used)
//   { id, op: 'tessel' }                           -> { id, tessel: { instructions, tools } }
//     (what Tessel's team tools give an agent: teamMcp/server.cjs's own answers)
// A failure answers { id, error }.
import fs from 'node:fs'
import path from 'node:path'
import { countEncoding, hfTokenizer, kimiTokenizer } from './tokenizers'
import teamServer from '../teamMcp/server.cjs'

const MAX_TOKENIZER_BYTES = 64 * 1024 * 1024
const loadedTokenizers = new Map() // dir -> Promise<{ count }>, the last two used

function loadTokenizer(loader) {
  const dir = String((loader && loader.dir) || '')
  if (loadedTokenizers.has(dir)) {
    const p = loadedTokenizers.get(dir)
    loadedTokenizers.delete(dir)
    loadedTokenizers.set(dir, p)
    return p
  }
  const p = (async () => {
    const read = (name) => {
      const file = path.join(dir, name)
      if (fs.statSync(file).size > MAX_TOKENIZER_BYTES) throw new Error(`${name} is too large`) // i18n-ignore internal
      return fs.readFileSync(file, 'utf8')
    }
    let jinja
    try {
      jinja = read('chat_template.jinja')
    } catch {
      jinja = null // the template is in tokenizer_config.json, or there is none
    }
    const config = JSON.parse(read('tokenizer_config.json'))
    if (loader.format === 'tiktoken') return kimiTokenizer(read('tiktoken.model'), config, jinja)
    return hfTokenizer(JSON.parse(read('tokenizer.json')), config, jinja, { noTemplate: !!loader.noTemplate })
  })()
  p.catch(() => loadedTokenizers.delete(dir))
  loadedTokenizers.set(dir, p)
  while (loadedTokenizers.size > 2) loadedTokenizers.delete(loadedTokenizers.keys().next().value)
  return p
}

export function tesselContext(server = teamServer) {
  // Both of Tessel's servers come from this script (tessel_team and tessel_apps).
  if (typeof server.contextParts === 'function') return server.contextParts()
  const init = server.handle({ id: 1, method: 'initialize', params: {} })
  const list = server.handle({ id: 2, method: 'tools/list', params: {} })
  return { instructions: String((init && init.instructions) || ''), tools: Array.isArray(list && list.tools) ? list.tools : [] }
}

export async function answer(msg) {
  if (msg.op === 'encoding') {
    const texts = Array.isArray(msg.texts) ? msg.texts.map((t) => String(t ?? '')) : []
    return { id: msg.id, counts: await countEncoding(msg.encoding, texts) }
  }
  if (msg.op === 'tokenizer') {
    const tok = await loadTokenizer(msg.loader)
    const items = Array.isArray(msg.items) ? msg.items : []
    const done = items.map((item) => tok.count(item && typeof item === 'object' ? item : { kind: 'text', text: '' }))
    return { id: msg.id, counts: done.map((d) => d.tokens), templates: done.map((d) => d.template) }
  }
  if (msg.op === 'tessel') return { id: msg.id, tessel: tesselContext() }
  return { id: msg.id, error: 'unknown op' } // i18n-ignore internal
}

export function serve(port) {
  port.on('message', (event) => {
    const msg = event && event.data !== undefined ? event.data : event
    if (!msg || typeof msg !== 'object') return
    answer(msg).then(
      (reply) => port.postMessage(reply),
      (err) => port.postMessage({ id: msg.id, error: String((err && err.message) || err) })
    )
  })
}

// Started by Electron's utilityProcess.fork.
if (process.parentPort && typeof process.parentPort.on === 'function') serve(process.parentPort)
