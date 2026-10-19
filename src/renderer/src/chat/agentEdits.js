// An agent's file tools as things to open (an agentic IDE's baseline): the
// file a Read / Edit / Write / apply_patch card names, at the line it read or
// first changed; the before / after of an edit for an editor diff tab; and the
// files a turn changed, for the strip under it (NativeChatChangedFiles.vue).
// Pure: the chat's components (use-agent-edit-actions.js) read the files and
// open the tabs.
//
// Every agent Tessel shows: Claude Code (Read, Edit, MultiEdit, Write,
// NotebookEdit), Codex (apply_patch, its app-server's file changes), Cursor
// (read_file, edit_file, search_replace), Gemini (read_file, write_file,
// replace), Antigravity (view_file, write_to_file, replace_file_content, their
// paths sometimes JSON-encoded twice), OpenCode (read, edit, write), Copilot
// (view, edit, create).
import { isRemotePath, parseRemotePath } from '../../../shared/remotePath.js'
import { isLsharePath } from '../../../shared/liveSharePath.js'
import { remoteLinkTarget } from './remoteChatLinks.js'

const CONTROL = /[\u0000-\u001f\u007f]/
const MAX_PATH = 4096

const READ_TOOLS = new Set(['read', 'read_file', 'readfile', 'view', 'view_file', 'notebookread', 'view_image', 'viewimage'])
const EDIT_TOOLS = new Set([
  'edit',
  'multiedit',
  'write',
  'notebookedit',
  'str_replace',
  'str_replace_editor',
  'str_replace_based_edit_tool',
  'edit_file',
  'write_file',
  'write_to_file',
  'create',
  'create_file',
  'replace',
  'search_replace',
  'replace_file_content',
  'multi_replace_file_content',
  'patch',
  'apply_patch'
])
// The keys a file tool names its file with, in the order they are trusted.
const PATH_KEYS = ['file_path', 'filePath', 'notebook_path', 'target_file', 'targetFile', 'TargetFile', 'AbsolutePath', 'absolute_path', 'absolutePath', 'path', 'file']
// Where a read starts (1-based in every one of these tools).
const START_KEYS = ['start_line_one_indexed', 'StartLine', 'startLine', 'start_line', 'line']

const record = (v) => (v && typeof v === 'object' && !Array.isArray(v) ? v : null)
const posInt = (n) => (Number.isSafeInteger(n) && n > 0 ? n : null)
const toolKey = (name) => String(name || '').toLowerCase()

// A path value as the tool wrote it ("C:/a.js", or Antigravity's "\"C:/a.js\"").
function pathValue(v) {
  if (typeof v !== 'string') return null
  let s = v.trim()
  if (s.length > 1 && s.startsWith('"') && s.endsWith('"')) {
    try {
      const inner = JSON.parse(s)
      if (typeof inner === 'string') s = inner.trim()
    } catch {
      return null
    }
  }
  return s && s.length <= MAX_PATH && !CONTROL.test(s) ? s : null
}

export function isFileReadTool(name) {
  return READ_TOOLS.has(toolKey(name))
}
export function isFileEditTool(name) {
  return EDIT_TOOLS.has(toolKey(name))
}

// The one file a tool call names, and the line it is about.
// -> { path, line, read, edit } | null (not a file tool, or several files:
// those are the edit cards' own, one per file).
export function toolFileTarget(block) {
  if (!block || block.type !== 'tool-call') return null
  const read = isFileReadTool(block.name)
  const edit = isFileEditTool(block.name)
  if (!read && !edit) return null
  const input = record(block.input)
  if (!input) return null
  let path = null
  for (const key of PATH_KEYS) {
    path = pathValue(input[key])
    if (path) break
  }
  if (!path) return null
  let line = null
  if (read) {
    // Claude Code's Read: offset is the line it starts at.
    if (block.name === 'Read') line = posInt(input.offset)
    for (const key of START_KEYS) line = line ?? posInt(input[key])
  } else line = posInt(block.editLine)
  return { path, line, read, edit }
}

// ---- Paths -------------------------------------------------------------------

const isWindowsAbs = (p) => /^[A-Za-z]:[\\/]/.test(p)
export function isAbsoluteToolPath(p) {
  return typeof p === 'string' && (isWindowsAbs(p) || p.startsWith('/') || isRemotePath(p) || isLsharePath(p))
}

// base + rel, "." and ".." resolved, in the base's own style (Windows or POSIX).
// -> null when rel climbs above the base's root.
export function joinToolPath(base, rel) {
  if (typeof base !== 'string' || !base || typeof rel !== 'string' || !rel) return null
  const win = isWindowsAbs(base)
  const sep = win ? '\\' : '/'
  const root = win ? base.slice(0, 2) : ''
  const segs = (win ? base.slice(2) : base).split(/[\\/]+/).filter(Boolean)
  for (const s of rel.split(win ? /[\\/]+/ : /\/+/)) {
    if (!s || s === '.') continue
    if (s === '..') {
      if (!segs.length) return null
      segs.pop()
    } else segs.push(s)
  }
  return `${root}${sep}${segs.join(sep)}`
}

// The file a tool's path names, ready to open.
// context: the chat's file-link context (use-native-chat-file-link-context.js:
//   { worktreePath, remote, remoteRoot }), or null: a conversation from
//   elsewhere (a Live Share host's), whose files never open here.
// fromPatch: the path came from a patch's text (Codex's apply_patch), which
//   names files relative to the folder the turn ran in (block.cwd), never
//   rewritten by the chat; a path of the tool's input was made relative to
//   the chat's own folder (block.folder, journalAdapter.js).
// -> a local absolute path, an ssh:// virtual path, or null.
export function resolveToolPath(path, { block = null, context = null, fromPatch = false } = {}) {
  const text = pathValue(path)
  if (!text || !context) return null
  if (/^[\\/]{2}/.test(text)) return null
  const cwd = block && typeof block.cwd === 'string' ? block.cwd : null
  const folder = block && typeof block.folder === 'string' ? block.folder : null
  const bases = (fromPatch ? [cwd, folder] : [folder, cwd]).filter(Boolean)
  if (context.remote) {
    const root = parseRemotePath(context.remoteRoot)
    if (!root) return null
    if (isRemotePath(text)) {
      const p = parseRemotePath(text)
      return p && p.hostId === root.hostId ? text : null
    }
    // A Windows path is this PC's, never the host's.
    if (isWindowsAbs(text) || text.includes('\\')) return null
    let named = text
    if (!text.startsWith('/') && !text.startsWith('~')) {
      const base = bases.find((b) => b.startsWith('/'))
      if (base) named = joinToolPath(base, text)
    }
    // The host's own rules (a "~/…" project, "." and ".."): remoteChatLinks.js.
    const hit = named ? remoteLinkTarget(context.remoteRoot, named) : null
    return hit ? hit.file : null
  }
  if (isRemotePath(text) || isLsharePath(text)) return null
  if (isWindowsAbs(text) || text.startsWith('/')) return text
  if (text.startsWith('~')) return null
  const base = bases.find((b) => isWindowsAbs(b) || b.startsWith('/')) || context.worktreePath
  return base ? joinToolPath(base, text) : null
}

// Whether a path is one the tool's input gave (made relative to the chat's
// folder) rather than one read from a patch's text.
export function isInputPath(block, path) {
  const input = record(block && block.input)
  if (!input || typeof path !== 'string') return false
  if (PATH_KEYS.some((k) => pathValue(input[k]) === path)) return true
  return Array.isArray(input.changes) && input.changes.some((c) => record(c) && c.path === path)
}

// ---- Edits -------------------------------------------------------------------
// One edited file's steps, from before to after:
//   { kind: 'replace', before, after, all }: a text replaced (Claude's Edit);
//   { kind: 'lines', before: [...], after: [...], lead }: a hunk of whole lines
//     (a patch), lead its unchanged lines before the first change;
//   { kind: 'write', text, created }: the whole file written;
//   { kind: 'deleted', text }: the file removed (text: what it held, if shown).

const str = (v) => (typeof v === 'string' ? v : null)
const nl = (s) => String(s).replace(/\r\n?/g, '\n')
const CREATED = /^\s*File created successfully/

function replaceStep(e) {
  const r = record(e)
  if (!r) return null
  const before = str(r.old_string) ?? str(r.oldString) ?? str(r.TargetContent) ?? str(r.old_str)
  const after = str(r.new_string) ?? str(r.newString) ?? str(r.ReplacementContent) ?? str(r.new_str)
  if (before === null && after === null) return null
  return { kind: 'replace', before: nl(before ?? ''), after: nl(after ?? ''), all: r.replace_all === true || r.replaceAll === true || r.AllowMultiple === true }
}

function linesSteps(file) {
  if (file.changeKind === 'added') return [{ kind: 'write', text: file.lines.filter((l) => l.kind === 'add').map((l) => l.text).join('\n'), created: true }]
  if (file.changeKind === 'deleted') return [{ kind: 'deleted', text: file.lines.filter((l) => l.kind === 'del').map((l) => l.text).join('\n') }]
  const steps = []
  let cur = null
  const flush = () => {
    if (cur && (cur.changed || cur.before.length !== cur.after.length)) steps.push({ kind: 'lines', before: cur.before, after: cur.after, lead: cur.lead })
    cur = null
  }
  for (const l of file.lines) {
    if (l.kind === 'gap') {
      flush()
      continue
    }
    if (!cur) cur = { before: [], after: [], lead: 0, changed: false }
    if (l.kind === 'context') {
      cur.before.push(l.text)
      cur.after.push(l.text)
      if (!cur.changed) cur.lead++
    } else {
      cur.changed = true
      if (l.kind === 'del') cur.before.push(l.text)
      else cur.after.push(l.text)
    }
  }
  flush()
  return steps
}

// block: the tool call; file: its NativeChatEditFile (an edit card's), or
// null for a tool line; resultText: the call's output, when there is one.
// -> steps[] | null
export function editSteps(block, file = null, resultText = '') {
  if (!block || block.type !== 'tool-call') return null
  const input = record(block.input)
  const single = toolFileTarget(block)
  const sameFile = !file || !single || file.path === single.path || !isInputPath(block, file.path)
  if (input && sameFile && !Array.isArray(input.changes)) {
    if (Array.isArray(input.edits) && input.edits.length) {
      const steps = input.edits.map(replaceStep).filter(Boolean)
      if (steps.length) return steps
    }
    const one = replaceStep(input)
    if (one) return [one]
    const content = str(input.content) ?? str(input.file_text) ?? str(input.CodeContent) ?? str(input.contents)
    if (content !== null) {
      const created = (file && file.changeKind === 'added') || input.command === 'create' || CREATED.test(String(resultText || ''))
      return [{ kind: 'write', text: nl(content), created }]
    }
  }
  if (file && Array.isArray(file.lines)) {
    const steps = linesSteps(file)
    return steps.length ? steps : null
  }
  return null
}

const lineOfIndex = (text, index) => {
  let n = 1
  for (let i = 0; i < index; i++) if (text.charCodeAt(i) === 10) n++
  return n
}
// The lines two texts start with in common (never all of b's).
function sharedLeadLines(a, b) {
  const x = a.split('\n')
  const y = b.split('\n')
  let i = 0
  while (i < x.length && i < y.length - 1 && x[i] === y[i]) i++
  return i
}
function findLines(hay, needle, from = 0) {
  if (!needle.length) return -1
  const same = (a, b) => a === b || a.trimEnd() === b.trimEnd()
  outer: for (let i = from; i + needle.length <= hay.length; i++) {
    for (let j = 0; j < needle.length; j++) if (!same(hay[i + j], needle[j])) continue outer
    return i
  }
  return -1
}

// The file's first changed line, from the card's own line numbers (a patch
// that carried them). -> a line number or null.
export function firstChangedLine(file) {
  if (!file || !file.lineNumbersKnown || !Array.isArray(file.lines)) return null
  let lastNew = null
  for (const l of file.lines) {
    if (l.kind === 'add') return posInt(l.newLineNumber)
    if (l.kind === 'del') return lastNew !== null ? lastNew + 1 : posInt(l.oldLineNumber)
    if (l.kind === 'context' && posInt(l.newLineNumber)) lastNew = l.newLineNumber
    if (l.kind === 'gap') lastNew = null
  }
  return null
}

// Where the steps' first change is in `text` (the file as it is now).
// -> a line number or null.
export function locateSteps(text, steps) {
  if (typeof text !== 'string' || !Array.isArray(steps)) return null
  const body = nl(text)
  let best = null
  const take = (n) => {
    if (posInt(n) && (best === null || n < best)) best = n
  }
  let lines = null
  for (const s of steps) {
    if (s.kind === 'write') take(1)
    else if (s.kind === 'replace') {
      if (!s.after) continue
      const at = body.indexOf(s.after)
      if (at >= 0) take(lineOfIndex(body, at) + sharedLeadLines(s.before, s.after))
    } else if (s.kind === 'lines') {
      lines = lines || body.split('\n')
      const at = findLines(lines, s.after)
      if (at >= 0) take(at + 1 + Math.min(s.lead, Math.max(0, s.after.length - 1)))
    }
  }
  return best
}

// The file before the steps, from `text` (the file after them, as it is now).
// -> the text before, or null when a step cannot be undone here (the file
// changed since, or a whole write of a file that existed: its old content
// is not in the steps).
export function revertSteps(text, steps) {
  if (typeof text !== 'string' || !Array.isArray(steps) || !steps.length) return null
  let body = nl(text)
  for (let i = steps.length - 1; i >= 0; i--) {
    const s = steps[i]
    if (s.kind === 'write') {
      if (!s.created) return null
      body = ''
    } else if (s.kind === 'deleted') {
      body = s.text
    } else if (s.kind === 'replace') {
      if (!s.after) return null
      const at = body.indexOf(s.after)
      if (at < 0) return null
      body = s.all ? body.split(s.after).join(s.before) : body.slice(0, at) + s.before + body.slice(at + s.after.length)
    } else if (s.kind === 'lines') {
      const lines = body.split('\n')
      const at = findLines(lines, s.after)
      if (at < 0) return null
      lines.splice(at, s.after.length, ...s.before)
      body = lines.join('\n')
    } else return null
  }
  return body
}

// The steps alone, side by side (what the agent's call showed): the diff tab's
// fallback when the file's whole before cannot be rebuilt.
export function snippetSides(steps) {
  const before = []
  const after = []
  for (const s of steps || []) {
    if (s.kind === 'replace') {
      before.push(s.before)
      after.push(s.after)
    } else if (s.kind === 'lines') {
      before.push(s.before.join('\n'))
      after.push(s.after.join('\n'))
    } else if (s.kind === 'write') {
      before.push('')
      after.push(s.text)
    } else if (s.kind === 'deleted') {
      before.push(s.text)
      after.push('')
    }
  }
  // An empty line between two snippets, on both sides, keeps them apart.
  return { original: before.join('\n\n'), modified: after.join('\n\n') }
}

// ---- A turn's changed files --------------------------------------------------

// messages: the chat's messages; turnKeys[i]: the turn of messages[i] (its
// user message's id); editCardsOf(blocks): native-chat-edit-cards.js's
// buildEditCards (passed in: this module stays free of the chat's parsers).
// -> Map turnKey -> { files: [{ path, oldPath, added, removed, changeKind,
//    edits: [{ block, file }] }], added, removed }
export function turnChangedFiles(messages, turnKeys, editCardsOf) {
  const turns = new Map()
  for (const [index, message] of (messages || []).entries()) {
    const turnKey = turnKeys[index]
    if (!turnKey || !message || message.role === 'user' || !Array.isArray(message.blocks)) continue
    // Fast path: most messages hold no tool call at all.
    if (!message.blocks.some((b) => b && b.type === 'tool-call')) continue
    for (const [block, edit] of editCardsOf(message.blocks).editCards) {
      let files = turns.get(turnKey)
      if (!files) turns.set(turnKey, (files = new Map()))
      for (const file of edit.files) {
        const key = file.path
        const renamed = file.oldPath && file.oldPath !== file.path ? files.get(file.oldPath) : undefined
        if (renamed) files.delete(file.oldPath)
        const prior = files.get(key) || renamed
        files.set(key, {
          path: file.path,
          oldPath: prior ? prior.oldPath || (renamed ? renamed.path : null) : file.oldPath || null,
          added: file.added + (prior ? prior.added : 0),
          removed: file.removed + (prior ? prior.removed : 0),
          changeKind: prior && prior.changeKind === 'added' && file.changeKind !== 'deleted' ? 'added' : file.changeKind,
          edits: [...(prior ? prior.edits : []), { block, file }]
        })
      }
    }
  }
  return new Map(
    Array.from(turns, ([key, byPath]) => {
      const files = Array.from(byPath.values())
      return [key, { files, added: files.reduce((n, f) => n + f.added, 0), removed: files.reduce((n, f) => n + f.removed, 0) }]
    })
  )
}
