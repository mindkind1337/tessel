// Live Share: an agent pane's conversation for guests, read only.
//
// A guest can look at a host's agent pane as a chat on its own screen (its
// own view: the host's pane, its mode, its terminal and its agent never
// change). The host reads the pane's conversation file the way its own chat
// view does (src/main/chat/transcriptView.js gives the chat events) and sends
// the guests who asked for it a smaller copy, made here (guestChatPayload):
// only what the conversation says (your messages, the agent's answers, each
// tool it ran by name with a short label, how each turn ended). Never what
// the tools read or printed (file contents, command output), the agent's
// thinking, images or attached files, nor the harness's own turns (a
// background task's report, shell output, reminders, other sessions' and
// teammates' messages, Tessel's own notes: src/shared/harnessInjectedTurns.js).
// Paths outside the pane's project folders are hidden ("…"), paths inside are
// written from the project's folder, and what looks like a key, a token or a
// password is masked (best effort: patterns). Bounded: the latest
// CHAT_LIMITS.events events, each text cut, CHAT_LIMITS.bytes in all. Each
// guest gets what changed since what it has (shareHost.js: how many of its
// oldest events go, how many of the rest stay, the new ones after them, and
// how many it then has). The guest takes the host's events as they are, one
// for one (checkedEvent: known kinds and fields, cut to the limits, anything
// else kept as an event the chat ignores), so its copy lines up with the
// host's record of it; one that does not line up asks for all of it again.
//
// Both sides say what they speak beyond the protocol version in the sealed
// join and welcome (SHARE_FEATURES): an older Tessel sends none and ignores
// them, so a host and a guest of different versions still work together
// (only without the conversation). Besides 'chat' (this file): 'agents' (the
// host lists the agents a guest may ask for, and a guest without the right
// to open asks the host instead) and 'presence' (the guest says which of the
// host's panes it has on screen, for the host's eyes only), shareHost.js;
// and phase 2's 'files' (a shared project's files, editor and notes), 'scm'
// (its git changes) and 'tasks' (its task board), through the requests and
// subscriptions of shareChannel.js; phase 2b's 'panes2' (what each shared
// pane runs and how it is, its sub-agents), 'usage' (the host's usage, with
// the right) and 'history' (the task history, a file's Local History, a task
// branch's changes; with phase 2c, its past agent conversations, its terminal
// agents' and its activity: shareHistory.js, shareActivity.js); 'tabs' (the
// host's editor tabs: shareTabs.js) and 'links' (its browser pages as links
// a guest opens in its own browser: shareLinks.js); 'paste' (an image a guest
// pastes into a pane it may type in: sharePaste.js). An older 'pages' (the
// host's pages streamed as pictures) is no longer spoken.

import { KNOWN_HARNESS_TAG_NAMES } from '../../shared/harnessInjectedTurns.js'

export const SHARE_FEATURES = Object.freeze(['chat', 'agents', 'presence', 'files', 'scm', 'tasks', 'panes2', 'usage', 'history', 'tabs', 'links', 'paste'])
export const cleanFeatures = (list) => (Array.isArray(list) ? [...new Set(list.filter((f) => typeof f === 'string' && SHARE_FEATURES.includes(f)))] : [])

export const CHAT_LIMITS = Object.freeze({
  events: 300,
  user: 8 * 1024,
  assistant: 16 * 1024,
  label: 300,
  name: 80,
  error: 1000,
  bytes: 512 * 1024
})
// What a host says when it has no conversation to send (yet).
export const CHAT_CODES = Object.freeze(['missing', 'busy', 'unavailable', 'error'])
// The tool input fields a guest gets (short labels: what it ran, on which
// file); never contents, patches, edits or prompts.
const TOOL_FIELDS = ['command', 'cmd', 'file_path', 'path', 'pattern', 'url', 'query', 'description']
const TOOL_STATUS = new Set(['running', 'done', 'completed', 'error', 'failed', 'stopped'])
const TURN_STATUS = new Set(['completed', 'interrupted', 'failed'])
const ID = /^[\w.:#@-]{1,160}$/
const MASK = '••••'
const HIDDEN = '…'

const str = (v) => (typeof v === 'string' ? v : '')
function clip(s, max) {
  const text = str(s)
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
const idOf = (v) => (typeof v === 'string' && ID.test(v) ? v : null)
const timeOf = (v) => (Number.isFinite(v) ? v : undefined)

// --- Secrets ------------------------------------------------------------------
const VALUE = `("[^"\\r\\n]{1,200}"|'[^'\\r\\n]{1,200}'|[^\\s"',;&]{3,200})`
const SECRET_NAME = '[A-Za-z0-9_.-]{0,40}(?:token|secret|passw(?:or)?d|passwd|pwd|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credential|session[_-]?key|connection[_-]?string)[A-Za-z0-9_.-]{0,40}'
const SECRETS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, MASK],
  [/\b([a-z][a-z0-9+.-]{1,20}:\/\/)[^\s/@:]{1,200}:[^\s/@]{1,200}@/gi, `$1${MASK}@`],
  [/\b(?:sk|pk|rk)[-_](?:ant-|proj-|live[-_]|test[-_]|or-)?[A-Za-z0-9_-]{16,}/g, MASK],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, MASK],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bglpat-[A-Za-z0-9_-]{10,}/g, MASK],
  [/\bglsa_[A-Za-z0-9_]{20,}/g, MASK],
  [/\bdo[por]_v1_[A-Za-z0-9]{20,}/g, MASK],
  [/\bxai-[A-Za-z0-9]{20,}/g, MASK],
  [/\bnpm_[A-Za-z0-9]{20,}/g, MASK],
  [/\bhf_[A-Za-z0-9]{20,}/g, MASK],
  [/\bya29\.[A-Za-z0-9_-]{10,}/g, MASK],
  [/\bxox[a-z]-[A-Za-z0-9-]{6,}/g, MASK],
  [/\b(?:AKIA|ASIA|AGPA|AIDA|AROA)[0-9A-Z]{12,}/g, MASK],
  [/\bAIza[0-9A-Za-z_-]{20,}/g, MASK],
  [/\beyJ[A-Za-z0-9_-]{6,}(?:\.[A-Za-z0-9_-]{2,}){1,2}/g, MASK],
  [/\b(AccountKey|SharedAccessKey|SharedAccessSignature|sig)=[^;&\s"']+/gi, `$1=${MASK}`],
  [/\b(Bearer|Basic|bearer)\s+(?=[A-Za-z0-9._~+/=-]{0,200}[0-9=])[A-Za-z0-9._~+/=-]{12,}/g, `$1 ${MASK}`],
  // NAME=value, name: value, "name": "value" where the name says it is a
  // secret (whatever the value looks like).
  [new RegExp(`\\b(${SECRET_NAME})(["']?[ \\t]{0,4}[:=][ \\t]{0,4})${VALUE}`, 'gi'), (all, name, sep, value) => `${name}${sep}${/^["']/.test(value) ? `${value[0]}${MASK}${value[0]}` : MASK}`],
  // mysql -uroot -pSecret (the password stuck to -p).
  [/\b((?:mysql|mysqldump|mysqladmin|mariadb|mariadb-dump)\b[^\n]{0,300}?\s-p)(?!\s)[^\s"']+/gi, `$1${MASK}`],
  // A long run of letters (both cases) and digits outside a path: a key.
  [/(?<![\w/\\.-])(?=[A-Za-z0-9+/_=-]{0,200}\d)(?=[A-Za-z0-9+/_=-]{0,200}[a-z])(?=[A-Za-z0-9+/_=-]{0,200}[A-Z])[A-Za-z0-9+/_=-]{40,}/g, MASK]
]
export function maskSecrets(text) {
  let out = str(text)
  for (const [re, to] of SECRETS) out = out.replace(re, to)
  return out
}

// Before anything is looked for: no terminal codes (one before a path or a
// key would hide it from the patterns), %-encoded characters decoded
// (C%3A%5CUsers...), and Windows' long-path prefixes (\\?\C:\..., \\?\UNC\...)
// written plainly.
/* eslint-disable no-control-regex */
const ANSI = /\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[PX^_][^\x1b]*\x1b\\|[@-Z\\-_])|[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g
/* eslint-enable no-control-regex */
const decodeOnce = (text) =>
  text.replace(/%([0-9A-Fa-f]{2})/g, (all, hex) => {
    const c = parseInt(hex, 16)
    return c >= 0x20 && c < 0x7f ? String.fromCharCode(c) : all
  })
export function plainText(text) {
  let out = str(text).replace(ANSI, '')
  // Decoded until nothing changes (C%253A... is C%3A... is C:...).
  for (let i = 0; i < 6 && /%[0-9A-Fa-f]{2}/.test(out); i++) {
    const next = decodeOnce(out)
    if (next === out) break
    out = next
  }
  return out.replace(/\\\\[?.]\\UNC\\/gi, '\\\\').replace(/\\\\[?.]\\(?=[A-Za-z]:)/g, '')
}

// --- Paths --------------------------------------------------------------------
// A path as compared: forward slashes, its . and .. resolved (never above
// its drive or share), no trailing slash; Windows paths (a drive, a share:
// \\server or //server) without case. -> { path, win } | null
function normalizedPath(p) {
  const s0 = str(p).trim()
  if (!s0 || s0.length > 4096) return null
  const unc = /^(?:\\\\|\/\/)(?![\\/])/.test(s0)
  const drive = /^[A-Za-z]:[\\/]/.test(s0)
  if (!unc && !drive && !s0.startsWith('/')) return null
  const parts = s0.replace(/[\\/]+/g, '/').split('/').filter((x) => x !== '' && x !== '.')
  const floor = drive ? 1 : unc ? 2 : 0
  const out = []
  for (const part of parts) {
    if (part !== '..') out.push(part)
    else if (out.length > floor) out.pop()
  }
  const path = unc ? `//${out.join('/')}` : drive ? out.join('/') : `/${out.join('/')}`
  const win = unc || drive
  return { path: win ? path.toLowerCase() : path, raw: path, win }
}
// A project folder (a whole drive or / is none).
function normalizedRoot(p) {
  const s0 = str(p)
  // eslint-disable-next-line no-control-regex -- control characters are what it refuses
  if (/[\u0000-\u001f]/.test(s0) || s0.length > 1024) return null
  const n = normalizedPath(s0)
  if (!n || n.path === '/' || /^[a-z]:$/i.test(n.path) || /^\/\/[^/]*$/.test(n.path)) return null
  return { path: n.path, win: n.win }
}
export function cleanRoots(list) {
  const out = []
  for (const r of Array.isArray(list) ? list.slice(0, 8) : []) {
    const n = normalizedRoot(r)
    if (n && !out.some((x) => x.path === n.path)) out.push(n)
  }
  return out
}
// A pane's folders a guest's copy of its conversation is written from: only
// the shared project's own folders and those of the pane inside them. A
// pane opened in a folder outside the project (the home folder, another
// repository) never makes that folder's paths readable: they are hidden
// like any other host path. -> the raw paths kept
export function chatRootsWithin(paneRoots, projectRoots) {
  const projects = cleanRoots(projectRoots)
  const out = (Array.isArray(projectRoots) ? projectRoots : []).filter((r) => normalizedRoot(r))
  for (const r of Array.isArray(paneRoots) ? paneRoots : []) {
    const n = normalizedRoot(r)
    if (n && projects.some((p) => p.win === n.win && (n.path === p.path || n.path.startsWith(`${p.path}/`)))) out.push(r)
  }
  return [...new Set(out)]
}

// Every text of a guest's chat payload (what guestEvent wrote: messages,
// tool labels and inputs, a turn's error), in order; fn(text, i) gives each
// one's replacement (the hidden files' names out, shareHiddenText.js).
export function mapChatTexts(payload, fn) {
  const texts = []
  const at = (obj, k) => {
    if (!obj || typeof obj[k] !== 'string' || !obj[k]) return
    texts.push(obj[k])
    obj[k] = fn(obj[k], texts.length - 1)
  }
  for (const ev of (payload && Array.isArray(payload.events) && payload.events) || []) {
    for (const k of ['text', 'summary', 'error']) at(ev, k)
    if (ev.input && typeof ev.input === 'object') for (const k of Object.keys(ev.input)) at(ev.input, k)
  }
  return texts
}

// One path found in the text: from the project's folder when it is inside
// one (after its .. are resolved), else hidden.
function rewritePath(raw, roots) {
  const n = normalizedPath(raw)
  if (!n) return HIDDEN
  for (const root of roots) {
    if (root.win !== n.win) continue
    if (n.path === root.path) return '.'
    if (n.path.startsWith(`${root.path}/`)) return n.raw.slice(root.path.length + 1)
  }
  return HIDDEN
}
const TRAILING = /[.,;:!?)\]}'"`]+$/
// What a path is made of, and a space inside one (followed by more of it: a
// word with a folder separator before the next space).
const PC = `[^\\s"'\`<>|*?]`
const PSP = `[ \\t](?=${PC}*[\\\\/]|[^\\s"'\`<>|*?\\\\/]{1,64}\\.[A-Za-z0-9]{1,8}(?:$|[\\s"'\`<>|),;]))`
const PATH_BODY = `(?:${PC}|${PSP})*`
// Where a path may start: not inside a word or another path, or right after
// a flag (-I/usr/include, --prefix=/opt/x).
const START = `(?:(?<![\\w\\\\/:.~-])|(?<=(?:^|[^\\w-])-{1,2}[A-Za-z][\\w-]{0,30}=?))`
const PATHS = [
  // ssh://host/..., smb://..., ftp://...: the host's paths, all hidden.
  [/\b(?:ssh|sftp|scp|smb|ftps?):\/\/[^\s"'`<>]+/gi, 'hide'],
  // file:// links
  [/\bfile:\/\/\/?[^\s"'`<>)\]]+/gi, 'file'],
  // A quoted path, spaces and all.
  [/(["'`])((?:[A-Za-z]:[\\/]|\\\\|\/\/(?!\/)|~[\\/]|\/[^/"'`\r\n]+\/)[^"'`\r\n]{0,1024}?)\1/g, 'quoted'],
  // C:\... also stuck to the text before it (Error:C:\..., xC:\...); C:/...
  // on its own (host:/path is a host's, http://... an address).
  [new RegExp(`(?:(?<![\\\\/.])[A-Za-z]:\\\\|(?<![\\w\\\\/.])[A-Za-z]:/(?!/))${PATH_BODY}`, 'g'), 'path'],
  // \\server\share\... and //server/share/...
  [new RegExp(`(?<![\\w\\\\/:])(?:\\\\\\\\[^\\s\\\\/]+\\\\|//[^\\s\\\\/]+/)${PATH_BODY}`, 'g'), 'path'],
  // ///etc/passwd: extra slashes are still the root.
  [new RegExp(`(?<![\\w\\\\/:.-])/{3,}${PATH_BODY}`, 'g'), 'hide'],
  // $HOME/..., ${HOME}/...: a home or working folder named by a variable, hidden.
  [new RegExp(`\\$\\{?(?:HOME|USERPROFILE|PWD|OLDPWD|TMPDIR|XDG_[A-Z_]{1,20})\\}?[\\\\/]${PATH_BODY}`, 'g'), 'hide'],
  // %USERPROFILE%\...
  [new RegExp(`%(?:USERPROFILE|HOMEPATH|APPDATA|LOCALAPPDATA|TEMP|TMP)%[\\\\/]${PATH_BODY}`, 'gi'), 'hide'],
  // ~/... and ~user/...: a home folder, hidden.
  [new RegExp(`(?<![\\w\\\\/~.-])~[\\w.-]{0,32}[\\\\/]${PATH_BODY}`, 'g'), 'hide'],
  // ../...: above the folder it was written from, hidden.
  [new RegExp(`(?<![\\w.\\\\/-])\\.\\.[\\\\/]${PATH_BODY}`, 'g'), 'hide'],
  // /two/segments... (one segment, like /compact, is a command, not a path),
  // also after a host (user@host:/home/...) or a flag.
  [new RegExp(`(?:${START}|(?<=[\\w.-]:))/(?!/)(?:[^\\s"'\`<>|/\\\\]+/)+${PATH_BODY}`, 'g'), 'path'],
  // /etc, /root...: one segment is a command (/compact), except a system
  // folder, hidden.
  [new RegExp(`(?:${START}|(?<=[\\w.-]:))/(?:etc|root|home|var|proc|sys|usr|opt|srv)(?![\\w.-])`, 'g'), 'hide']
]
// user@host (before a path, or after ssh, scp...): which server it is stays
// with the host.
const LOGIN_PATH = /\b[\w.-]{1,64}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}(?=:[\\/~.])/g
const LOGIN_CMD = /(?<=\b(?:ssh|scp|sftp|rsync|mosh)\b[^\n]{0,200}?\s)[\w.-]{1,64}@[A-Za-z0-9][A-Za-z0-9.-]{0,252}/g
export function hidePaths(text, roots) {
  let out = str(text)
  if (!roots) return out
  for (const [re, kind] of PATHS) {
    out = out.replace(re, (match, quote, inner) => {
      if (kind === 'quoted') return `${quote}${rewritePath(inner, roots)}${quote}`
      const tail = (match.match(TRAILING) || [''])[0]
      let p = tail ? match.slice(0, -tail.length) : match
      if (!p) return match
      if (kind === 'hide') return HIDDEN + tail
      if (kind === 'file') {
        p = p.replace(/^file:\/\/\/?/i, '')
        if (!/^[A-Za-z]:[\\/]/.test(p) && !p.startsWith('/')) p = `/${p}`
      }
      return rewritePath(p, roots) + tail
    })
  }
  return out.replace(LOGIN_PATH, MASK).replace(LOGIN_CMD, MASK)
}

// What a guest may read of a text: secrets masked, paths outside the project
// hidden (roots null: paths as they are, the guest's own check), cut.
// Cut first (a little past the end: a secret across the cut is still seen
// whole), so no pattern ever runs over more than that.
export function guestText(text, roots, max) {
  return clip(hidePaths(maskSecrets(plainText(clip(text, max + 256))), roots), max)
}

// The harness's own user turns (never the conversation): known by their
// exact form (structure, not only their first words), so a prompt that only
// starts like one is kept.
const HARNESS_TAGS = [...KNOWN_HARNESS_TAG_NAMES].join('|')
const LEADING_HARNESS_TAG = new RegExp(`^<(?:${HARNESS_TAGS})(?:\\s[^>]{0,500})?>`, 'i')
const HARNESS_TAG_INSIDE = new RegExp(`<(?:${HARNESS_TAGS})(?:\\s[^>]{0,500})?>`, 'i')
// Tessel's typed team messages: "(message <id>[, reply to <id>]) ..." with
// its ids (letters and a dash: <source>-<pane>).
const TEAM_HEAD = /^\(message (?=[\w.:-]{0,120}[A-Za-z])(?=[\w.:-]{0,120}-)[\w.:-]{3,120}(?:, reply to [\w.:-]{1,120})?\) /
export function harnessUserText(text) {
  const s0 = plainText(str(text).slice(0, 64 * 1024)).replace(/^\s+/, '')
  if (!s0) return false
  // A harness block opening the message (a background task's report, shell
  // input or output, a reminder, a teammate's or another session's message).
  if (LEADING_HARNESS_TAG.test(s0)) return true
  // Tessel's own notes, and team messages it typed in.
  if (s0.startsWith('[Tessel] ') || TEAM_HEAD.test(s0)) return true
  if (/^\[Request interrupted by user[^\]\n]{0,80}\]\s*$/.test(s0)) return true
  if (/^No response requested\.\s*$/.test(s0)) return true
  // "Another Claude session sent a message:\n<cross-session-message ...": the
  // words, then the block.
  if (/^(?:A message arrived from |Another Claude session sent a message)/.test(s0) && HARNESS_TAG_INSIDE.test(s0.slice(0, 2048))) return true
  if (/^<channel source=/.test(s0) && /<\/channel>/.test(s0)) return true
  if (/^Caveat: The messages below were generated by the user while running local commands/.test(s0)) return true
  return /^This session is being continued from a previous conversation/.test(s0)
}

// A harness block inside a prompt cut out: from its opening tag to its LAST
// closing tag (a closing tag written inside it never ends it early); one
// never closed goes to the end, but only when it starts a line (as the
// harness writes it): "what does <system-reminder> mean" stays.
const HARNESS_OPEN = new RegExp(`<(${HARNESS_TAGS})(?:\\s[^>]{0,500})?>`, 'gi')
export function stripHarnessBlocks(text) {
  let out = str(text)
  let from = 0
  for (let i = 0; i < 64; i++) {
    HARNESS_OPEN.lastIndex = from
    const m = HARNESS_OPEN.exec(out)
    if (!m) break
    const tag = m[1].toLowerCase()
    const lower = out.toLowerCase()
    const close = lower.lastIndexOf(`</${tag}`)
    let end = -1
    if (close > m.index) {
      const gt = out.indexOf('>', close)
      end = gt < 0 ? out.length : gt + 1
    } else if (/(?:^|\n)[ \t]*$/.test(out.slice(Math.max(0, m.index - 200), m.index))) end = out.length
    if (end < 0) {
      from = m.index + m[0].length
      continue
    }
    out = out.slice(0, m.index) + out.slice(end)
    from = m.index
  }
  return out
}

// --- Events -------------------------------------------------------------------
function toolInput(input, roots) {
  let value = input
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value)
    } catch {
      return {}
    }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {}
  const out = {}
  for (const k of TOOL_FIELDS) {
    const v = value[k]
    const s = typeof v === 'string' ? v : Array.isArray(v) && v.every((x) => typeof x === 'string') ? v.join(' ') : null
    if (s) out[k] = guestText(s, roots, CHAT_LIMITS.label)
  }
  return out
}

// One chat event as a guest may get it, or null (a kind a guest never gets).
function guestEvent(ev, roots) {
  if (!ev || typeof ev !== 'object') return null
  const at = timeOf(ev.at)
  const base = (o) => ({ ...o, imported: true, ...(at !== undefined ? { at } : {}) })
  switch (ev.type) {
    case 'user': {
      const id = idOf(ev.id)
      if (!id || harnessUserText(ev.text)) return null
      const text = stripHarnessBlocks(str(ev.text).slice(0, 64 * 1024)).trim()
      if (!text) return null
      const origin = ev.origin === 'team' ? 'team' : 'user'
      return base({ type: 'user', id, text: guestText(text, roots, CHAT_LIMITS.user), origin, status: 'accepted', ...(origin === 'team' && typeof ev.from === 'string' ? { from: clip(ev.from, 40) } : {}) })
    }
    case 'assistant': {
      const messageId = idOf(ev.messageId)
      return messageId ? base({ type: 'assistant', messageId, text: guestText(ev.text, roots, CHAT_LIMITS.assistant) }) : null
    }
    case 'tool': {
      const id = idOf(ev.id)
      if (!id) return null
      const status = TOOL_STATUS.has(ev.status) ? ev.status : undefined
      // A status-only update (no name): the call it closes stays as it was.
      if (ev.name == null) return base({ type: 'tool', id, ...(status ? { status } : {}) })
      return base({ type: 'tool', id, name: clip(ev.name, CHAT_LIMITS.name), summary: guestText(ev.summary, roots, CHAT_LIMITS.label), input: toolInput(ev.input, roots), ...(status ? { status } : {}) })
    }
    case 'toolResult': {
      const id = idOf(ev.id)
      // What it read or printed stays on the host: done or failed only.
      return id ? base({ type: 'toolResult', id, isError: ev.isError === true, text: '' }) : null
    }
    case 'turnEnd': {
      const status = TURN_STATUS.has(ev.status) ? ev.status : 'completed'
      const durationMs = Number.isFinite(ev.durationMs) && ev.durationMs >= 0 ? Math.round(ev.durationMs) : undefined
      const error = typeof ev.error === 'string' && ev.error ? guestText(ev.error, roots, CHAT_LIMITS.error) : ''
      return base({ type: 'turnEnd', status, ...(durationMs !== undefined ? { durationMs } : {}), ...(error ? { error } : {}) })
    }
    default:
      return null
  }
}

// The events a guest gets: the latest ones that fit CHAT_LIMITS (count and
// bytes). roots: the project folders (cleanRoots) for the host's copy, null
// for the guest's check. -> { events, truncated }
export function guestChatEvents(events, roots = null, limits = CHAT_LIMITS) {
  const list = Array.isArray(events) ? events : []
  const out = []
  let bytes = 2
  let truncated = false
  // From the newest: what fits is kept, the rest (the oldest) left out.
  for (let i = list.length - 1; i >= 0; i--) {
    const ev = guestEvent(list[i], roots)
    if (!ev) continue
    const size = Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1
    if (out.length >= limits.events || bytes + size > limits.bytes) {
      truncated = true
      break
    }
    bytes += size
    out.push(ev)
  }
  return { events: out.reverse(), truncated }
}

// What the host sends a guest for a conversation: { ok: true, events,
// truncated } (read from the file: transcriptView's answer) or { ok: false,
// code }.
export function guestChatPayload(read, roots) {
  if (!read || read.ok !== true) return { ok: false, code: CHAT_CODES.includes(read && read.code) ? read.code : 'missing' }
  const { events, truncated } = guestChatEvents(read.events, cleanRoots(roots))
  return { ok: true, events, truncated: truncated || !!read.truncated }
}

// The guest's check of one event: known kinds and fields only, each text cut
// to the limits, nothing else changed (the window escapes what it shows);
// anything else is kept in its place as an event the chat ignores, so the
// guest's events stay one for one with the host's.
const SKIP = Object.freeze({ type: 'skip' })
function checkedEvent(ev) {
  if (!ev || typeof ev !== 'object') return SKIP
  const at = timeOf(ev.at)
  const base = (o) => ({ ...o, imported: true, ...(at !== undefined ? { at } : {}) })
  switch (ev.type) {
    case 'user': {
      const id = idOf(ev.id)
      if (!id) return SKIP
      const origin = ev.origin === 'team' ? 'team' : 'user'
      return base({ type: 'user', id, text: clip(ev.text, CHAT_LIMITS.user), origin, status: 'accepted', ...(origin === 'team' && typeof ev.from === 'string' ? { from: clip(ev.from, 40) } : {}) })
    }
    case 'assistant': {
      const messageId = idOf(ev.messageId)
      return messageId ? base({ type: 'assistant', messageId, text: clip(ev.text, CHAT_LIMITS.assistant) }) : SKIP
    }
    case 'tool': {
      const id = idOf(ev.id)
      if (!id) return SKIP
      const status = TOOL_STATUS.has(ev.status) ? ev.status : undefined
      if (ev.name == null) return base({ type: 'tool', id, ...(status ? { status } : {}) })
      const input = {}
      const raw = ev.input && typeof ev.input === 'object' && !Array.isArray(ev.input) ? ev.input : {}
      for (const k of TOOL_FIELDS) if (typeof raw[k] === 'string') input[k] = clip(raw[k], CHAT_LIMITS.label)
      return base({ type: 'tool', id, name: clip(ev.name, CHAT_LIMITS.name), summary: clip(ev.summary, CHAT_LIMITS.label), input, ...(status ? { status } : {}) })
    }
    case 'toolResult': {
      const id = idOf(ev.id)
      return id ? base({ type: 'toolResult', id, isError: ev.isError === true, text: '' }) : SKIP
    }
    case 'turnEnd': {
      const status = TURN_STATUS.has(ev.status) ? ev.status : 'completed'
      const durationMs = Number.isFinite(ev.durationMs) && ev.durationMs >= 0 ? Math.round(ev.durationMs) : undefined
      const error = typeof ev.error === 'string' && ev.error ? clip(ev.error, CHAT_LIMITS.error) : ''
      return base({ type: 'turnEnd', status, ...(durationMs !== undefined ? { durationMs } : {}), ...(error ? { error } : {}) })
    }
    default:
      return SKIP
  }
}
const countOf = (v) => (Number.isSafeInteger(v) && v >= 0 && v <= 100000 ? v : null)

// The guest's check of an update: { ok: true, dropped, from, events, total,
// truncated } (the counts checked, each event checked one for one) or
// { ok: false, code }. null: not one.
export function cleanChatMessage(msg) {
  if (!msg || typeof msg !== 'object') return null
  if (msg.ok !== true) return { ok: false, code: CHAT_CODES.includes(msg.code) ? msg.code : 'error' }
  const events = (Array.isArray(msg.events) ? msg.events.slice(0, CHAT_LIMITS.events + 1) : []).map(checkedEvent)
  const dropped = countOf(msg.dropped) ?? 0
  const from = countOf(msg.from) ?? 0
  const total = countOf(msg.total) ?? from + events.length
  return { ok: true, dropped, from, events, total, truncated: !!msg.truncated }
}

// The guest's copy after an update: its events without the `dropped` oldest,
// the first `from` of the rest, then the new ones; exactly `total` of them,
// within the limits. null: it does not line up with what the guest has (it
// asks for all of it again).
export function mergeChatEvents(prev, update) {
  const have = Array.isArray(prev) ? prev : []
  if (!update || update.ok !== true || !Array.isArray(update.events)) return null
  const dropped = countOf(update.dropped) ?? 0
  const from = countOf(update.from) ?? 0
  const total = countOf(update.total) ?? from + update.events.length
  if (dropped > have.length || from > have.length - dropped) return null
  const merged = have.slice(dropped, dropped + from).concat(update.events)
  if (merged.length !== total || merged.length > CHAT_LIMITS.events) return null
  let bytes = 0
  for (const ev of merged) bytes += Buffer.byteLength(JSON.stringify(ev), 'utf8') + 1
  return bytes > CHAT_LIMITS.bytes + 64 * 1024 ? null : merged
}

// The host's agent panes a guest can look at as a chat, as the guest gets
// them: { id, title, agentId, accent, terminal } (terminal: the host's pane
// has one; a pane in chat mode has none).
// Why a pane has no conversation to show (the host says it, so the guest's
// chat button can say it too instead of vanishing): 'agent' (an agent whose
// conversation Tessel cannot read, here or on an SSH server: a guest is not
// told which), 'none' (it has none yet).
export const CHAT_REASONS = Object.freeze(['agent', 'none'])
export function cleanChatPanes(list, max = 64) {
  const out = []
  for (const c of Array.isArray(list) ? list.slice(0, max) : []) {
    if (!c || typeof c.id !== 'string' || !/^[\w-]{1,80}$/.test(c.id) || out.some((x) => x.id === c.id)) continue
    out.push({
      id: c.id,
      title: clip(c.title, 200),
      agentId: typeof c.agentId === 'string' && /^[\w-]{1,40}$/.test(c.agentId) ? c.agentId : null,
      accent: /^#[0-9a-f]{3,8}$/i.test(c.accent || '') ? c.accent : null,
      terminal: c.terminal !== false,
      ...(CHAT_REASONS.includes(c.reason) ? { reason: c.reason } : {})
    })
  }
  return out
}
