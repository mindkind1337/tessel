// A pane's title from its agent's own conversation (after Orca's): Claude
// Code's title for the conversation (a /rename, else the one it generates),
// or a short one made from its first message; Codex's thread name.
// Read-only, local files only.
import fs from 'fs'
import os from 'os'
import { join } from 'path'

const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const MAX_TITLE = 80

// A short stable title from a prompt (Orca's deriveGeneratedTabTitle): the
// first clause, without links, markdown or polite filler, at most 40 chars.
export function titleFromPrompt(text) {
  if (typeof text !== 'string') return ''
  let t = text.slice(0, 512)
  t = t.replace(/https?:\/\/\S+/g, ' ').replace(/[`*_~#>[\]{}()]/g, ' ')
  t = t.replace(/^\s*(issue|task|bug|feature|pr)\s*#?\d*\s*:\s*/i, '')
  t = t.split(/[.!?;\n]/).find((x) => x.trim()) || ''
  t = t.trim()
  const fillers = [
    /^(can|could|would) you (please )?/i,
    /^please /i,
    /^i (want|need) (you )?to /i,
    /^help me (to )?/i,
    /^help /i,
    /^let'?s /i,
    /^we need to /i,
    /^need to /i
  ]
  for (let pass = 0; pass < 3; pass++) for (const f of fillers) t = t.replace(f, '').trim()
  t = t.replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  if (!t) return ''
  t = t[0].toUpperCase() + t.slice(1)
  if (t.length > 40) {
    const cut = t.slice(0, 40)
    const space = cut.lastIndexOf(' ')
    t = space >= 40 * 0.55 ? cut.slice(0, space) : cut
  }
  return t
}

// The text of a user message record (a string, or its text parts).
function userText(o) {
  const c = o && o.message && o.message.content
  if (typeof c === 'string') return c
  if (Array.isArray(c)) return c.filter((p) => p && p.type === 'text' && typeof p.text === 'string').map((p) => p.text).join(' ')
  return ''
}

// Tessel's own lines and tool results are not the conversation's subject.
function isRealPrompt(text) {
  const t = text.trim()
  return t && !t.startsWith('<') && !/^\[Tessel\]/.test(t) && !/^Caveat:/.test(t)
}

// Per transcript: how far it was read, and what was found (files only grow).
const claudeState = new Map()

function findClaudeTranscript(id, claudeDir) {
  const root = join(claudeDir, 'projects')
  let dirs
  try {
    dirs = fs.readdirSync(root, { withFileTypes: true })
  } catch {
    return null
  }
  for (const d of dirs) {
    if (!d.isDirectory()) continue
    const f = join(root, d.name, `${id}.jsonl`)
    if (fs.existsSync(f)) return f
  }
  return null
}

// Reads in small steps without blocking Tessel (a long transcript is
// ~100 MB); calls for the same file while one runs share it.
const reading = new Map()

// claudeDir: Claude Code's folder (~/.claude, or an account's).
export async function claudeSessionTitle(id, claudeDir = join(os.homedir(), '.claude')) {
  if (!ID.test(String(id))) return ''
  const file = findClaudeTranscript(id, claudeDir)
  if (!file) return ''
  if (!reading.has(file)) {
    reading.set(
      file,
      readClaudeTitle(file).finally(() => reading.delete(file))
    )
  }
  const st = await reading.get(file)
  return st ? (st.custom || st.ai || st.first || '').trim().slice(0, MAX_TITLE) : ''
}

async function readClaudeTitle(file) {
  let st = claudeState.get(file)
  let size
  try {
    size = (await fs.promises.stat(file)).size
  } catch {
    return null
  }
  if (!st || size < st.offset) st = { offset: 0, tail: '', custom: '', ai: '', first: '' }
  let fh
  try {
    fh = await fs.promises.open(file, 'r')
  } catch {
    return null
  }
  try {
    // Only what was added since the last read, 2 MB at a time.
    while (size > st.offset) {
      const len = Math.min(size - st.offset, 2 * 1024 * 1024)
      const buf = Buffer.alloc(len)
      const { bytesRead } = await fh.read(buf, 0, len, st.offset)
      if (!bytesRead) break
      st.offset += bytesRead
      const lines = (st.tail + buf.toString('utf8', 0, bytesRead)).split('\n')
      st.tail = lines.pop()
      if (st.tail.length > 1024 * 1024) st.tail = '' // one huge line: skip it
      for (const line of lines) scanLine(st, line)
    }
  } finally {
    await fh.close()
  }
  claudeState.set(file, st)
  return st
}

function scanLine(st, line) {
  if (!line.includes('"type":"custom-title"') && !line.includes('"type":"ai-title"') && (st.first || !line.includes('"type":"user"')))
    return
  let o
  try {
    o = JSON.parse(line)
  } catch {
    return
  }
  if (o.type === 'custom-title' && typeof o.customTitle === 'string') st.custom = o.customTitle
  else if (o.type === 'ai-title' && typeof o.aiTitle === 'string') st.ai = o.aiTitle
  else if (o.type === 'user' && !st.first && !o.isMeta) {
    const text = userText(o)
    if (isRealPrompt(text)) st.first = titleFromPrompt(text)
  }
}

export function codexSessionTitle(id, codexHome = process.env.CODEX_HOME || join(os.homedir(), '.codex')) {
  if (!ID.test(String(id))) return ''
  let text
  try {
    text = fs.readFileSync(join(codexHome, 'session_index.jsonl'), 'utf8')
  } catch {
    return ''
  }
  let name = ''
  // The latest line for this id wins (a rename appends one).
  for (const line of text.split('\n')) {
    if (!line.includes(id)) continue
    try {
      const o = JSON.parse(line)
      if (o && o.id === id && typeof o.thread_name === 'string') name = o.thread_name
    } catch {
      /* a line being written */
    }
  }
  return name.trim().slice(0, MAX_TITLE)
}
