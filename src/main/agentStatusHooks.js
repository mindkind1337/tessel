// Status hooks for the agents whose hooks, plugin or extension only tell Tessel
// when they work, wait for you, or are done (never team messages: those come
// as the typed reminder). Each runs the shared hook script
// (teamMcp/server.cjs --hook --agent=<id>), which turns the agent's own events
// into Tessel's status events, bound to the pane's launch (agentStateStore.js).
//
// Where each agent reads its hooks, and which events, after Orca's
// src/main/{cursor,droid,grok,antigravity,openclaude,command-code,qoder,dsh}/hook-service.ts,
// src/main/amp/agent-status-plugin-source.ts and
// src/main/pi/agent-status-extension-source.ts, MIT, Copyright (c) 2026 Lovecast Inc.
//
// Only Tessel's own entries are added, replaced or removed (the command runs
// Tessel's script); the user's other hooks and settings stay as they are. A
// file Tessel cannot read is left alone. Writes are atomic, and the first
// change keeps a copy of the user's file (<file>.before-tessel), deleted when
// Tessel's hooks are removed.
//
// Every command runs node by its absolute path (nodePath.js), never by name:
// hooks run in the project folder, where a planted node.exe would run instead.
import fs from 'fs'
import os from 'os'
import { dirname, isAbsolute, join } from 'path'
import { readJson } from './fileRead'
import { writeFileAtomic } from './safeJson'
import { t } from './i18n'
import { hookNode, hookCommand, pluginNodeSource, findNode } from './nodePath'
import { dshHome, dshPatchStatus, installDshPatch, removeDshPatchFile } from './dshHooks'

const OURS = 'tessel-team-mcp.cjs'
const record = (v) => v !== null && typeof v === 'object' && !Array.isArray(v)
const envDir = (env, name) => {
  const value = Object.entries(env || {}).find(([key]) => key.toUpperCase() === name)?.[1]
  return typeof value === 'string' && isAbsolute(value) ? value : null
}

// Tessel's command for one of an agent's events (node: its absolute path).
export const statusCommand = (scriptPath, agent, event, node) =>
  hookCommand(node, scriptPath, `--hook --agent=${agent}${event ? ` --event=${event}` : ''}`)
const isOurs = (command) => typeof command === 'string' && command.includes(OURS) && command.includes('--agent=')

// shape: 'claude' = { hooks: { Event: [{ matcher, hooks: [{ type, command }] }] } }
//        'flat'   = { version: 1, hooks: { event: [{ command }] } } (Cursor)
//        'bundle' = { <bundle>: { Event: [definition] } } (Antigravity)
//        'plugin' = a file of Tessel's own (Amp plugin, Pi extension)
export const STATUS_HOOKS = {
  cursor: {
    shape: 'flat',
    file: (home) => join(home, '.cursor', 'hooks.json'),
    // Not its permission gates (beforeShellExecution...): an answer there would
    // decide for the user.
    events: ['beforeSubmitPrompt', 'postToolUse', 'postToolUseFailure', 'stop'],
    // Tessel's entry comes first: its neutral answer to beforeSubmitPrompt
    // ({"continue":true}) can then never override the user's own hook that
    // blocks a prompt. Installed only when the user turns it on (Settings):
    // a failing or left-behind prompt hook may block every Cursor prompt.
    first: true,
    optIn: true
  },
  droid: {
    shape: 'claude',
    file: (home) => join(home, '.factory', 'settings.json'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PermissionRequest', 'Notification', 'Stop'],
    matcher: { PreToolUse: '*', PostToolUse: '*', PermissionRequest: '*' }
  },
  grok: {
    shape: 'claude',
    own: true,
    file: (home, env) => join(envDir(env, 'GROK_HOME') || join(home, '.grok'), 'hooks', 'tessel-status.json'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'Notification', 'Stop', 'StopCancelled', 'StopFailure', 'SessionEnd'],
    matcher: { PreToolUse: '.*', PostToolUse: '.*', PostToolUseFailure: '.*' }
  },
  antigravity: {
    shape: 'bundle',
    bundle: 'tessel-status',
    file: (home) => join(home, '.gemini', 'config', 'hooks.json'),
    // Not PreToolUse: Antigravity takes silence there as a refusal.
    events: ['PreInvocation', 'PostInvocation', 'PostToolUse', 'Stop'],
    tool: ['PostToolUse']
  },
  openclaude: {
    shape: 'claude',
    file: (home) => join(home, '.openclaude', 'settings.json'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Notification', 'Stop', 'StopFailure', 'SessionEnd']
  },
  commandcode: {
    shape: 'claude',
    file: (home) => join(home, '.commandcode', 'settings.json'),
    events: ['PreToolUse', 'PostToolUse', 'Stop'],
    matcher: { PreToolUse: '.*', PostToolUse: '.*' }
  },
  // Qoder CLI: Claude Code's hooks format, in its own settings
  // (docs.qoder.com/cli/hooks).
  qoder: {
    shape: 'claude',
    file: (home) => join(home, '.qoder', 'settings.json'),
    events: ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'Stop', 'StopFailure', 'Notification', 'PostCompact']
  },
  // DeepSeek Harness: Tessel's own hooks file, read by dsh's Claude Code hook
  // bridge through a row Tessel adds to its home patch layer (dshHooks.js).
  // Only the events that bridge fires (it has no Notification or
  // PermissionRequest: an unknown name would register nothing).
  dsh: {
    shape: 'claude',
    own: true,
    patch: true,
    file: (home, env) => join(dshHome(home, env), 'tessel-status-hooks.json'),
    events: ['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PostToolUse', 'Stop']
  },
  amp: {
    shape: 'plugin',
    file: (home) => join(home, '.config', 'amp', 'plugins', 'tessel-status.ts'),
    source: (scriptPath, node) => ampPlugin(scriptPath, node)
  },
  pi: {
    shape: 'plugin',
    file: (home, env) => join(envDir(env, 'PI_CODING_AGENT_DIR') || join(home, '.pi', 'agent'), 'extensions', 'tessel-status.ts'),
    source: (scriptPath, node) => piExtension(scriptPath, node)
  }
}
export const STATUS_HOOK_AGENTS = Object.keys(STATUS_HOOKS)

export const PLUGIN_MARKER = '// Tessel status: written by Tessel and replaced when it updates; delete it to remove.'

// The status sender shared by the Amp plugin and the Pi extension: the hook
// script is run for each event, in order, one at a time, never waited for by
// the agent. Nothing but event names and ids is sent.
function sender(scriptPath, agent, node) {
  return `const SCRIPT = ${JSON.stringify(scriptPath)}
// Never "node" by name: run from the project folder, it could be a node.exe
// planted there.
const NODE: string = ${pluginNodeSource(node)}
const queue: string[] = []
let running = false
function next(): void {
  const input = queue.shift()
  if (!input) {
    running = false
    return
  }
  running = true
  try {
    const child = spawn(NODE, [SCRIPT, '--hook', '--agent=${agent}'], { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true })
    const timer = setTimeout(() => child.kill(), 20000)
    child.on('error', () => {})
    child.on('close', () => {
      clearTimeout(timer)
      next()
    })
    child.stdin.on('error', () => {})
    child.stdin.end(input)
  } catch {
    next()
  }
}
// Each event a later time than the one before: Tessel applies them in that order.
let last = 0
function status(event: string, sessionId: unknown, extra: Record<string, unknown> = {}): void {
  last = Math.max(Date.now(), last + 1)
  if (queue.length >= 50) queue.shift()
  queue.push(JSON.stringify({ hook_event_name: event, session_id: typeof sessionId === 'string' ? sessionId : '', tessel_at: last, ...extra }))
  if (!running) next()
}
`
}

export function ampPlugin(scriptPath, node) {
  return `${PLUGIN_MARKER}
// Amp: its thread starting, working and done, for Tessel's pane.
import { spawn } from 'node:child_process'

${sender(scriptPath, 'amp', node)}
export default function (amp: any) {
  if (!process.env.TESSEL_PANE_ID || !process.env.TESSEL_AGENT_LAUNCH) return
  const thread = (event: any) => (event && event.thread && typeof event.thread.id === 'string' ? event.thread.id : '')
  // A new thread in the pane is the pane's conversation from now on.
  amp.on('session.start', (event: any) => status('SessionStart', thread(event), { source: 'clear' }))
  amp.on('agent.start', (event: any) => status('UserPromptSubmit', thread(event)))
  amp.on('tool.result', (event: any) => status('PostToolUse', thread(event)))
  amp.on('agent.end', (event: any) => {
    const how = event && event.status
    status(how === 'cancelled' ? 'Interrupt' : how === 'error' ? 'StopFailure' : 'Stop', thread(event))
  })
}
`
}

export function piExtension(scriptPath, node) {
  return `${PLUGIN_MARKER}
// Pi: its turn, its tools and its sub-agents (pi-subagents), for Tessel's
// pane. Its turn is done only once it is idle and no sub-agent it started
// still runs.
import { spawn } from 'node:child_process'

${sender(scriptPath, 'pi', node)}
export default function (pi: any): void {
  if (!process.env.TESSEL_PANE_ID || !process.env.TESSEL_AGENT_LAUNCH) return
  // Its sub-agents inherit the pane's environment: only the pane's own Pi reports.
  const owner = process.env.TESSEL_PI_STATUS_OWNER
  if (owner && owner !== String(process.pid)) {
    try {
      process.kill(Number(owner), 0)
      return
    } catch {
      // that Pi is gone: this one is the pane's now
    }
  }
  process.env.TESSEL_PI_STATUS_OWNER = String(process.pid)
  let session = ''
  const track = (ctx: any) => {
    try {
      const id = ctx && ctx.sessionManager && ctx.sessionManager.getSessionId && ctx.sessionManager.getSessionId()
      if (typeof id === 'string' && id) session = id
    } catch {
      // keep the last one
    }
  }
  const children = new Set<string>()
  let ended = false // its turn ended, waiting for its sub-agents
  let check: ReturnType<typeof setTimeout> | null = null
  const finish = () => {
    if (check) clearTimeout(check)
    check = null
    if (children.size) {
      ended = true
      return
    }
    ended = false
    status('Stop', session)
  }
  const childId = (event: any) => {
    const raw = event && (typeof event.id === 'string' ? event.id : typeof event.runId === 'string' ? event.runId : '')
    return raw ? 'pi-' + raw.replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 120) : ''
  }
  const childEvent = (event: any, forced?: string) => {
    const id = childId(event)
    const how = forced || (event && event.status)
    if (!id) return
    if (how === 'started') {
      if (children.has(id)) return
      children.add(id)
      status('SubagentStart', session, { agent_id: id })
      status('PreToolUse', session, { agent_id: id })
    } else if (how === 'completed' || how === 'failed' || how === 'aborted') {
      if (!children.delete(id)) return
      status('SubagentStop', session, { agent_id: id })
      if (ended && !children.size) finish()
    }
  }
  const bus = pi.events
  if (bus && typeof bus.on === 'function') {
    bus.on('task:subagent:lifecycle', (event: any) => childEvent(event))
    bus.on('subagent:async-started', (event: any) => childEvent(event, 'started'))
    bus.on('subagent:async-complete', (event: any) => childEvent(event, 'completed'))
  }
  pi.on('session_start', (event: any, ctx: any) => {
    track(ctx)
    if (event && event.reason === 'reload') return
    status('SessionStart', session)
  })
  pi.on('agent_start', (_event: any, ctx: any) => {
    track(ctx)
    if (check) clearTimeout(check)
    check = null
    ended = false
    status('UserPromptSubmit', session)
  })
  pi.on('tool_execution_start', (event: any, ctx: any) => {
    track(ctx)
    status('PreToolUse', session, { tool_name: event && typeof event.toolName === 'string' ? event.toolName : '' })
  })
  pi.on('tool_execution_end', (_event: any, ctx: any) => {
    track(ctx)
    status('PostToolUse', session)
  })
  let settledEvents = false
  pi.on('agent_settled', (_event: any, ctx: any) => {
    track(ctx)
    settledEvents = true
    finish()
  })
  pi.on('agent_end', (event: any, ctx: any) => {
    track(ctx)
    // More of the same run follows, or agent_settled will say it is over.
    if ((event && event.willContinue === true) || settledEvents) return
    if (!ctx || typeof ctx.isIdle !== 'function') return finish()
    let wait = 25
    const recheck = () => {
      try {
        if (ctx.isIdle()) return finish()
      } catch {
        return finish()
      }
      check = setTimeout(recheck, wait)
      wait = Math.min(wait * 2, 250)
    }
    if (check) clearTimeout(check)
    check = setTimeout(recheck, 0)
  })
  pi.on('session_shutdown', () => {
    children.clear()
    status('SessionEnd', session)
  })
}
`
}

// -> { settings } or { error } (a file Tessel cannot read is never changed).
function readSettings(file) {
  if (!fs.existsSync(file)) return { settings: {}, exists: false }
  const settings = readJson(file)
  if (!record(settings))
    return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
  return { settings, exists: true }
}

function save(file, settings, exists) {
  fs.mkdirSync(dirname(file), { recursive: true })
  if (exists && !fs.existsSync(`${file}.before-tessel`)) fs.copyFileSync(file, `${file}.before-tessel`)
  writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n')
}

// A definition without Tessel's entries (null when nothing else is left).
function withoutOurs(definition) {
  if (!record(definition)) return definition
  if (isOurs(definition.command)) return null
  if (!Array.isArray(definition.hooks)) return definition
  const others = definition.hooks.filter((h) => !(record(h) && isOurs(h.command)))
  if (others.length === definition.hooks.length) return definition
  return others.length ? { ...definition, hooks: others } : null
}

// The definition Tessel writes for one event.
function definition(spec, event, command) {
  if (spec.shape === 'flat') return { command }
  if (spec.shape === 'bundle' && !spec.tool.includes(event)) return { type: 'command', command, timeout: 30 }
  const hook = { type: 'command', command, timeout: 30 }
  const matcher = spec.shape === 'bundle' ? '*' : spec.matcher && spec.matcher[event]
  return matcher ? { matcher, hooks: [hook] } : { hooks: [hook] }
}

// The event lists Tessel's entries live in: settings.hooks, or its bundle.
function eventTable(spec, settings, create) {
  const key = spec.shape === 'bundle' ? spec.bundle : 'hooks'
  if (record(settings[key])) return settings[key]
  // Something else under that name: never replaced.
  if (!create || settings[key] !== undefined) return null
  settings[key] = {}
  return settings[key]
}

// Install (or update) an agent's status hooks. -> { changed } or { error }
// `node`: the absolute node to run (found on PATH when not given; none found:
// nothing is installed).
export function installStatusHooks(agent, scriptPath, { home = os.homedir(), env = process.env, node } = {}) {
  const spec = STATUS_HOOKS[agent]
  if (!spec) return { error: `${agent}: no status hooks` } // i18n-ignore internal: programming error
  const result = installEntries(agent, spec, scriptPath, { home, env, node })
  if (result.error || !spec.patch) return result
  // dsh: its patch row points at the hooks file, written first.
  const patched = installDshPatch(spec.file(home, env), { home, env })
  return patched.error ? patched : { changed: !!(result.changed || patched.changed) }
}

function installEntries(agent, spec, scriptPath, { home, env, node }) {
  const found = hookNode(scriptPath, node, env)
  if (found.error) return found
  const file = spec.file(home, env)
  try {
    if (spec.shape === 'plugin') {
      const text = spec.source(scriptPath, found.node)
      if (fs.existsSync(file)) {
        const old = fs.readFileSync(file, 'utf8')
        if (old === text) return { changed: false }
        if (!old.startsWith(PLUGIN_MARKER)) return { error: t('main.hooks.notTessels', "{{file}} is not Tessel's, so it was left alone.", { file }) }
      }
      fs.mkdirSync(dirname(file), { recursive: true })
      writeFileAtomic(file, text)
      return { changed: true }
    }
    const read = readSettings(file)
    if (read.error) return { error: read.error }
    const settings = read.settings
    const before = JSON.stringify(settings)
    const table = eventTable(spec, settings, true)
    if (!table) return { error: t('main.hooks.unreadable', '{{file}} could not be read, so Tessel did not change it.', { file }) }
    // Something else than a list under one of Tessel's events: never replaced.
    for (const event of spec.events)
      if (table[event] !== undefined && !Array.isArray(table[event]))
        return { error: t('main.hooks.notList', '{{file}} has a setting for {{event}} that is not a list of hooks, so Tessel did not change it.', { file, event }) }
    // Tessel's entries of events it no longer uses go too.
    for (const event of Object.keys(table)) {
      if (spec.events.includes(event) || !Array.isArray(table[event])) continue
      const kept = table[event].map(withoutOurs).filter((d) => d !== null)
      if (kept.length) table[event] = kept
      else delete table[event]
    }
    for (const event of spec.events) {
      const command = statusCommand(scriptPath, agent, event, found.node)
      const list = Array.isArray(table[event]) ? table[event] : []
      const kept = list.map(withoutOurs).filter((d) => d !== null)
      const ours = definition(spec, event, command)
      table[event] = spec.first ? [ours, ...kept] : [...kept, ours]
    }
    if (spec.shape === 'flat' && settings.version === undefined) settings.version = 1
    // Nothing new: the file is left as it is (not even reformatted).
    if (read.exists && sameEntries(spec, JSON.parse(before), scriptPath, agent, found.node)) return { changed: false }
    save(file, settings, read.exists)
    return { changed: true }
  } catch (err) {
    return { error: `${file}: ${err.message}` }
  }
}

// The file already has exactly Tessel's current entries (and no stale ones).
function sameEntries(spec, settings, scriptPath, agent, node) {
  const status = eventStatus(spec, settings, scriptPath, agent, node)
  return status.every && !status.stale
}

// -> { events: { Event: bool }, every, stale } for a parsed settings file.
function eventStatus(spec, settings, scriptPath, agent, node) {
  const table = eventTable(spec, settings, false) || {}
  const events = {}
  let stale = false
  for (const [event, list] of Object.entries(table)) {
    if (!Array.isArray(list)) continue
    const want = node ? statusCommand(scriptPath, agent, event, node) : null
    list.forEach((d, index) => {
      const commands = record(d) ? [d.command, ...(Array.isArray(d.hooks) ? d.hooks.map((h) => record(h) && h.command) : [])] : []
      for (const c of commands) {
        if (!isOurs(c)) continue
        if (c === want && spec.events.includes(event) && !events[event]) {
          events[event] = true
          // Not first where it must be: moved there on the next install.
          if (spec.first && index !== 0) stale = true
        } else stale = true
      }
    })
  }
  const out = Object.fromEntries(spec.events.map((e) => [e, !!events[e]]))
  if (spec.shape === 'flat' && settings.version === undefined) stale = true
  return { events: out, every: spec.events.every((e) => out[e]), stale }
}

// Remove an agent's status hooks: only Tessel's entries (or its own file).
// -> { changed } or { error }
export function removeStatusHooks(agent, { home = os.homedir(), env = process.env } = {}) {
  const spec = STATUS_HOOKS[agent]
  if (!spec) return { changed: false }
  const file = spec.file(home, env)
  // dsh: its patch row goes first (never pointing at a missing file).
  let unpatched = { changed: false }
  if (spec.patch) {
    unpatched = removeDshPatchFile({ home, env })
    if (unpatched.error) return unpatched
  }
  const result = removeEntries(spec, file)
  // Tessel's copy of the user's file goes with its hooks (only once they are
  // gone: a failed removal keeps it).
  if (!result.error) dropBackup(file)
  return unpatched.changed && !result.error ? { ...result, changed: true } : result
}

// The copy of a user's file Tessel kept before its first change.
export function dropBackup(file) {
  try {
    fs.rmSync(`${file}.before-tessel`, { force: true })
  } catch {
    // left in place: harmless, and shown in Settings
  }
}

function removeEntries(spec, file) {
  try {
    if (!fs.existsSync(file)) return { changed: false }
    if (spec.shape === 'plugin') {
      if (!fs.readFileSync(file, 'utf8').startsWith(PLUGIN_MARKER)) return { changed: false }
      fs.rmSync(file, { force: true })
      return { changed: true }
    }
    const read = readSettings(file)
    if (read.error) return { error: read.error }
    const settings = read.settings
    const table = eventTable(spec, settings, false)
    if (!table) return { changed: false }
    let changed = false
    for (const event of Object.keys(table)) {
      if (!Array.isArray(table[event])) continue
      const kept = table[event].map(withoutOurs).filter((d) => d !== null)
      if (kept.length === table[event].length && kept.every((d, i) => d === table[event][i])) continue
      changed = true
      if (kept.length) table[event] = kept
      else delete table[event]
    }
    if (!changed) return { changed: false }
    if (spec.shape === 'bundle' && !Object.keys(table).length) delete settings[spec.bundle]
    // Tessel's own file with nothing else in it: removed.
    if (spec.own && (!record(settings.hooks) || !Object.keys(settings.hooks).length) && Object.keys(settings).every((k) => k === 'hooks')) {
      fs.rmSync(file, { force: true })
      return { changed: true }
    }
    writeFileAtomic(file, JSON.stringify(settings, null, 2) + '\n')
    return { changed: true }
  } catch (err) {
    return { error: `${file}: ${err.message}` }
  }
}

// Read-only, for Settings (teamHooksStatus.js): the same row as the other
// agents', marked statusOnly (its hooks bring no team messages).
export function statusHooksInstallation(agent, scriptPath, { home = os.homedir(), env = process.env, node = findNode({ env }) } = {}) {
  const spec = STATUS_HOOKS[agent]
  const row = { id: agent, hooks: 'missing', events: {}, approval: null, lastSignal: null, inbox: false, statusOnly: true, ...(spec && spec.optIn ? { optIn: true } : {}) }
  if (!spec) return row
  const file = spec.file(home, env)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    if (error.code !== 'ENOENT') {
      row.hooks = 'error'
      row.error = t('main.hooks.cannotRead', 'Cannot read {{label}}.', { label: `${agent} hooks` })
    }
    if (spec.shape === 'plugin') row.events = { Plugin: false }
    else row.events = Object.fromEntries(spec.events.map((e) => [e, false]))
    return row
  }
  if (spec.shape === 'plugin') {
    if (!text.startsWith(PLUGIN_MARKER)) {
      row.hooks = 'error'
      row.error = t('main.hooks.pluginNotManaged', 'This file is not managed by Tessel; it was left unchanged: {{file}}', { file })
      row.events = { Plugin: false }
      return row
    }
    row.events = { Plugin: !!scriptPath && !!node && text === spec.source(scriptPath, node) }
    row.hooks = row.events.Plugin ? 'installed' : 'partial'
    return row
  }
  let settings
  try {
    settings = JSON.parse(text)
    if (!record(settings)) throw new Error()
  } catch {
    row.hooks = 'error'
    // Never the file's content or a parser message: these files can hold secrets.
    row.error = t('main.hooks.invalidHooks', 'Cannot read {{agent}} hooks (invalid JSON or hook structure).', { agent })
    row.events = Object.fromEntries(spec.events.map((e) => [e, false]))
    return row
  }
  const status = scriptPath && node ? eventStatus(spec, settings, scriptPath, agent, node) : { events: Object.fromEntries(spec.events.map((e) => [e, false])), every: false }
  row.events = status.events
  const on = Object.values(status.events).filter(Boolean).length
  row.hooks = status.every ? 'installed' : on ? 'partial' : 'missing'
  // dsh reads the file only through its patch row.
  if (spec.patch && on) {
    const patch = dshPatchStatus(file, { home, env })
    if (patch.error) {
      row.hooks = 'error'
      row.error = patch.error
    } else if (patch !== 'installed') row.hooks = 'partial'
  }
  return row
}
