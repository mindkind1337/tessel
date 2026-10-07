// What a terminal agent asks you to approve, for the chat view's approval card
// (NativeChatTranscriptView.vue): the tool, its command, file or URL, and the
// choices the agent offers, instead of "it is shown in its terminal".
//
// The agent's hooks never carry a tool's input (they keep its identity only:
// src/shared/agentAsk.js), local or on an SSH host. So the card reads:
//   1. its conversation file (local, or the host's through the remote reader):
//      the tool call with no result yet in the current turn is the request;
//   2. else its screen: Claude Code's permission box ("Bash command", the
//      command, "Do you want to proceed?", "1. Yes", "2. Yes, and don't ask
//      again for ...", "3. No ...") or Codex's ("Would you like to run the
//      following command?", "$ cmd", "1. Yes, proceed (y)" ...);
//   3. else nothing: the card keeps its generic note.
// The choices come only from the screen (the file never says them); a choice
// is answered with its own number key, which the agent's selector takes.
// Everything here is the agent's text: untrusted, shown as text only (never
// as HTML), its control and bidirectional characters removed.

import { mcpToolIdentity } from './orca/shared/native-chat-tool-identity.js'
import { isCommandToolName } from './orca/shared/native-chat-tool-activity.js'
import { toolFilePath, toolInputCommand } from './orca/shared/native-chat-tool-summary.js'
import { unwrapLoginShellCommand } from './orca/shared/native-chat-tool-preview-prefix.js'
import { EDIT_TOOL_NAMES, diffFromToolCall, diffFromText } from './orca/shared/native-chat-diff.js'

const QUESTION_TOOLS = new Set(['AskUserQuestion', 'ask_user_question', 'askUserQuestion', 'request_user_input'])
// The agents whose approval selector takes a choice's number.
export const NUMBERED_CHOICE_AGENTS = ['claude', 'openclaude', 'codex']
const LIMITS = { text: 8000, line: 400, options: 9, detailLines: 40 }

const CONTROL = /[\u0000-\u0009\u000b-\u001f\u007f-\u009f‎‏‪-‮⁦-⁩]/g
// Untrusted text, cleaned: control and bidirectional characters removed
// (newlines kept), cut at max.
export function cleanText(value, max = LIMITS.text) {
  if (typeof value !== 'string') return ''
  let text = value.replace(/\r\n?/g, '\n').replace(CONTROL, '').slice(0, max)
  if (/[\ud800-\udbff]$/.test(text)) text = text.slice(0, -1)
  return text
}

// ---- 1. The conversation file -------------------------------------------------

// The tool calls of the current turn with no result yet (not a question tool:
// that has its own card). A prompt of yours, an interruption or the agent
// writing on after them (it went on: they were not waiting) clears them. The
// reader's own end of the file ("done" with no result) is not an answer.
// -> [{ id, name, input }] in the file's order.
export function pendingToolsFromEvents(events) {
  let pending = []
  for (const e of Array.isArray(events) ? events : []) {
    if (!e || typeof e !== 'object') continue
    if (e.type === 'user' && e.origin !== 'team') pending = []
    else if (e.type === 'turnEnd' && e.status === 'interrupted') pending = []
    else if (e.type === 'assistant' && pending.length) pending = []
    else if (e.type === 'tool' && e.name) {
      if (!QUESTION_TOOLS.has(e.name) && e.status === 'running') pending.push({ id: String(e.id), name: String(e.name), input: e.input })
    } else if (e.type === 'tool' && !e.name && e.status === 'stopped') pending = pending.filter((p) => p.id !== String(e.id))
    else if (e.type === 'toolResult') pending = pending.filter((p) => p.id !== String(e.id))
  }
  return pending
}

function parsedInput(input) {
  if (typeof input !== 'string') return input && typeof input === 'object' ? input : {}
  const first = input.trimStart()[0]
  if (first === '{' || first === '[') {
    try {
      const v = JSON.parse(input)
      if (v && typeof v === 'object') return v
    } catch {
      // kept as text
    }
  }
  return input
}

// The full command of a tool's input (not the one-line summary): a string, or
// an argv array (Codex: ["bash", "-lc", "cmd"] shows "cmd").
function fullCommand(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return typeof input === 'string' ? input : ''
  const raw = input.command ?? input.cmd
  let text = ''
  if (typeof raw === 'string') text = raw
  else if (Array.isArray(raw) && raw.every((p) => typeof p === 'string')) {
    const shell = raw.length === 3 && /(?:^|[\\/])(?:ba|z|k|da|fi)?sh(?:\.exe)?$/.test(raw[0]) && /^-[a-zA-Z]*c$/.test(raw[1])
    text = shell ? raw[2] : raw.join(' ')
  }
  return text ? unwrapLoginShellCommand(text) : ''
}

// Lines added and removed by an edit (Edit, MultiEdit, Write, apply_patch).
function diffStat(name, input) {
  let lines = null
  try {
    lines = typeof input === 'string' ? (name === 'apply_patch' ? diffFromText(input, 100000) : null) : diffFromToolCall(name, input, 100000)
    if (!lines && input && typeof input === 'object' && Array.isArray(input.edits)) {
      lines = input.edits.flatMap((ed) => diffFromToolCall('Edit', ed, 100000) || [])
    }
  } catch {
    lines = null
  }
  if (!Array.isArray(lines) || !lines.length) return null
  const added = lines.filter((l) => l.kind === 'add').length
  const removed = lines.filter((l) => l.kind === 'del').length
  return added || removed ? { added, removed } : null
}

function urlOf(input) {
  if (!input || typeof input !== 'object') return ''
  const u = input.url ?? input.uri
  return typeof u === 'string' ? u : ''
}

// A pending tool call as the card shows it.
// -> { source: 'transcript', tool, kind: 'command'|'file'|'url'|'mcp'|'other',
//      command?, path?, diff?, url?, mcp?, detail? }
export function requestFromTool(tool) {
  if (!tool || typeof tool.name !== 'string' || !tool.name) return null
  const name = cleanText(tool.name, 120)
  const input = parsedInput(tool.input)
  const out = { source: 'transcript', tool: name }
  const mcp = mcpToolIdentity(name)
  const command = fullCommand(input) || (isCommandToolName(name) && typeof input === 'string' ? input : '')
  if (mcp) {
    out.kind = 'mcp'
    out.mcp = { server: cleanText(mcp.server, 120), tool: cleanText(mcp.tool, 120) }
    const args = input && typeof input === 'object' ? JSON.stringify(input, null, 2) : typeof input === 'string' ? input : ''
    if (args && args !== '{}') out.detail = cleanText(args)
  } else if (command && (isCommandToolName(name) || toolInputCommand(input))) {
    out.kind = 'command'
    out.command = cleanText(command)
    if (input && typeof input === 'object' && typeof input.description === 'string' && input.description.trim()) out.detail = cleanText(input.description, 1000)
  } else if (EDIT_TOOL_NAMES.has(name) || name === 'NotebookEdit') {
    out.kind = 'file'
    const path = typeof input === 'object' ? toolFilePath(input) : patchPath(input)
    if (path) out.path = cleanText(path, LIMITS.line)
    const diff = diffStat(name, input)
    if (diff) out.diff = diff
  } else if (urlOf(input)) {
    out.kind = 'url'
    out.url = cleanText(urlOf(input), 2000)
    if (typeof input.prompt === 'string' && input.prompt.trim()) out.detail = cleanText(input.prompt, 1000)
  } else {
    out.kind = 'other'
    const path = typeof input === 'object' ? toolFilePath(input) : null
    if (path) out.path = cleanText(path, LIMITS.line)
    else {
      const args = input && typeof input === 'object' ? JSON.stringify(input, null, 2) : typeof input === 'string' ? input : ''
      if (args && args !== '{}') out.detail = cleanText(args)
    }
  }
  return out
}

// apply_patch's text input: its first file.
function patchPath(text) {
  if (typeof text !== 'string') return null
  const m = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/m.exec(text)
  return m ? m[1].trim() : null
}

// ---- 2. The screen -----------------------------------------------------------------

// The question line of an approval prompt (agentStateRules/common.json's
// approval rules, the ones that head a box of choices).
const QUESTION = /(Do you want to (?:proceed|make|create|allow|run|overwrite|delete)[^\n]*\?|Would you like to (?:run|make|apply)[^\n]*\?|Do you trust (?:the files|the contents|this)[^\n]*\?|Is this a (?:project|directory) you created or one you trust\?|Trust this folder\?|Implement this plan\?|Allow execution[^\n]*\?|Apply this change\??)/i
const BORDER_TOP = /^\s*[╭┌]|^\s*[─━═╌┄-]{8,}\s*$/
const BORDER_BOTTOM = /^\s*[╰└]/
const OPTION = /^\s*(?:[❯›>▶»→]\s*)?(\d)[.)]\s+(.+?)\s*$/
const strip = (line) => line.replace(/^\s*[│┃|▌▎]\s?/, '').replace(/\s*[│┃|]\s*$/, '')

// The approval prompt on screen. text: the screen's last lines (as
// TerminalPane's screenText gives them). -> { title, detail, question,
// options: [{ number, label }] } | null when no prompt with a question shows.
export function approvalFromScreen(text) {
  const raw = cleanText(String(text || ''), 32 * 1024)
  if (!raw) return null
  const lines = raw.split('\n')
  // The last question on screen (an older answered one may still show above).
  let q = -1
  for (let i = lines.length - 1; i >= 0; i--) {
    if (QUESTION.test(lines[i])) {
      q = i
      break
    }
  }
  if (q < 0) return null
  const question = strip(lines[q]).trim().slice(0, LIMITS.line)
  // Its choices: numbered lines after it; a line indented under a choice
  // continues it (a narrow pane wraps them); a footer ends them.
  const options = []
  let end = lines.length
  let optionIndent = -1
  for (let i = q + 1; i < lines.length; i++) {
    const line = strip(lines[i])
    if (BORDER_BOTTOM.test(lines[i])) {
      end = i
      break
    }
    const m = OPTION.exec(line)
    if (m && Number(m[1]) === options.length + 1) {
      options.push({ number: Number(m[1]), label: m[2].slice(0, LIMITS.line) })
      optionIndent = line.search(/\d/)
      continue
    }
    if (!line.trim()) continue
    if (options.length && line.search(/\S/) > optionIndent && !/\besc\b|\benter\b/i.test(line)) {
      const last = options[options.length - 1]
      last.label = `${last.label} ${line.trim()}`.slice(0, LIMITS.line)
      continue
    }
    if (options.length) {
      end = i
      break
    }
  }
  // Its box: from its top border (or a rule above it) down to the question;
  // without one, nothing above the question is taken (it could be the
  // conversation).
  let top = -1
  for (let i = q - 1; i >= Math.max(0, q - 30); i--) {
    if (BORDER_TOP.test(lines[i])) {
      top = i
      break
    }
  }
  const above = top >= 0 ? lines.slice(top + 1, q).map(strip) : []
  // Between the question and its choices (Codex shows the command there).
  const firstOption = options.length ? lines.findIndex((l, i) => i > q && OPTION.test(strip(l))) : end
  const below = lines.slice(q + 1, firstOption < 0 ? end : firstOption).map(strip)
  const content = [...above, ...below].map((l) => l.replace(/\s+$/, ''))
  while (content.length && !content[0].trim()) content.shift()
  while (content.length && !content[content.length - 1].trim()) content.pop()
  let title = ''
  if (above.some((l) => l.trim())) {
    title = content.shift().trim()
    while (content.length && !content[0].trim()) content.shift()
  }
  const detail = dedent(content.slice(0, LIMITS.detailLines))
    .map((l) => l.replace(/^\$\s+/, ''))
    .join('\n')
    .trim()
  return { title: title.slice(0, LIMITS.line), detail: detail.slice(0, LIMITS.text), question, options: options.slice(0, LIMITS.options) }
}

function dedent(lines) {
  const indents = lines.filter((l) => l.trim()).map((l) => l.search(/\S/))
  const min = indents.length ? Math.min(...indents) : 0
  return lines.map((l) => l.slice(min))
}

// ---- The choices -------------------------------------------------------------------

// A choice of the screen as the card shows it: { kind: 'yes' | 'always' | 'no'
// | 'other', label (the agent's own, its key hint cut), scope (for 'always':
// what "don't ask again" covers), keys (its number) }.
export function approvalChoice(option) {
  const label = String(option.label || '')
    // Claude writes "don’t" with a typographic apostrophe.
    .replace(/[‘’ʼ]/g, "'")
    .replace(/\s*\((?:esc|y|n|a|p|shift\+tab|tab|enter)\)\s*$/i, '')
    // Its gray hint after " · " ("auto mode handles these prompts for you").
    .replace(/\s+·\s+.*$/, '')
    .trim()
  const plainYes = /^yes\.?$/i.test(label)
  const scopeMatch = /(?:don'?t|do not) ask again for:?\s*(.+)$/i.exec(label)
  const always = !plainYes && /^yes\b/i.test(label) && /don'?t ask again|do not ask again|always|allow all|this session|for the session/i.test(label)
  const autoMode = /^yes\b.*\bauto mode\b/i.test(label)
  // Only a plain "Yes" is shown as "Yes": any other choice keeps what makes it different.
  const kind = plainYes ? 'yes' : always ? 'always' : autoMode ? 'auto' : /^no\b/i.test(label) ? 'no' : 'other'
  return { kind, label, scope: scopeMatch ? scopeMatch[1].trim() : '', number: option.number, keys: String(option.number) }
}

// ---- Together ------------------------------------------------------------------------

const squash = (s) => String(s || '').replace(/\s+/g, '').toLowerCase()
// What of a pending call its screen box would show (to tell which call it asks for).
function toolMark(tool) {
  const r = requestFromTool(tool)
  if (!r) return ''
  const text = r.command || r.path || r.url || (r.mcp && r.mcp.tool) || ''
  const first = squash(text.split('\n')[0]).slice(0, 24)
  return first || ''
}

// The card's request. agent: the pane's agent; events: its conversation
// file's events; screen: its screen's last lines ('' when unread).
// -> { tool, kind, command?, path?, diff?, url?, mcp?, detail?, question?,
//      source: 'transcript' | 'screen', choices: [approvalChoice] } | null
// (null: nothing readable, the generic note shows).
export function approvalRequest({ agent = '', events = [], screen = '' } = {}) {
  const box = approvalFromScreen(screen)
  const choices = box && NUMBERED_CHOICE_AGENTS.includes(agent) && box.options.length >= 2 ? box.options.map(approvalChoice) : []
  const pending = pendingToolsFromEvents(events)
  let tool = null
  if (pending.length) {
    const shown = box ? squash(`${box.title}\n${box.detail}`) : ''
    if (shown) {
      // The call the box shows; a box that shows none of them asks something else.
      tool = pending.find((p) => {
        const mark = toolMark(p)
        return mark && shown.includes(mark)
      })
      if (!tool && !box.detail && pending.length === 1) tool = pending[0]
    } else tool = pending[0]
  }
  const fromTool = tool ? requestFromTool(tool) : null
  if (fromTool) return { ...fromTool, ...(box && box.question ? { question: box.question } : {}), choices }
  if (box && (box.title || box.detail || choices.length)) {
    return {
      source: 'screen',
      tool: box.title,
      kind: 'screen',
      ...(box.detail ? { detail: box.detail } : {}),
      question: box.question,
      choices
    }
  }
  return null
}
