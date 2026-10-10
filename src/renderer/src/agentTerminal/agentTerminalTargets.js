// The window's side of the agents' terminal tools (src/main/agentTerminal.js
// asks it): which terminal, the agent's own terminals (made, reused, closed),
// running a command and watching it, reading, sending input, the approval
// card, and the notices to the agent when a command it left running ends.
//
// After Visual Studio Code's chat terminal tools (MIT, Copyright (c)
// Microsoft Corporation: src/vs/workbench/contrib/terminalContrib/
// chatAgentTools/browser/tools/{runInTerminalTool,getTerminalOutputTool,
// sendToTerminalTool,killTerminalTool,getTerminalLastCommandTool,
// getTerminalSelectionTool}.ts): an agent runs its commands in terminals of
// its own (one reused for commands it waits for, one more for each command
// left running), never in the user's, unless it names one of the user's
// terminals (Tessel's own addition: approved by the user once per terminal,
// never automatic).
//
// The rules:
// - Only an agent pane (a terminal agent or a chat) may call.
// - The user's terminals: never the agent's own pane, never a chat, browser
//   or editor pane; another agent's pane is read-only.
// - Nothing is typed into a user's terminal while the user types there.
// - "Let agents use terminals" off: nothing.
//
// The answers go to the agent: English on purpose.
import { executeCommand, watchForInput, waitForIdle } from './executeStrategy'
import { initLineFor } from './shellInit'
import { getLastLine } from '../../../shared/terminalOutput'
import { addPageNear } from '../browser/agentBrowserTargets'

export class AgentTerminalError extends Error {
  constructor(code, message) {
    super(message)
    this.code = code
  }
}
const refuse = (code, message) => new AgentTerminalError(code, message)

export const MAX_READ_LINES = 400
// An agent's own terminals at a time (the oldest finished one goes for a new one).
export const MAX_OWN_TERMINALS = 6
export const READY_TIMEOUT_MS = 20000
export const SEND_SETTLE_MS = 2000
export const SEND_WAIT_MAX_MS = 30000
export const ASYNC_IDLE_MS = 3000
// A terminal opened for a command left running (async, or the agent's
// terminal busy) closes this long after its command ended, unless the user
// used it (clicked into it, typed, resized or moved it).
export const AUTO_CLOSE_MS = 3000
// The last output of an agent's terminal that closed stays readable
// (get_terminal_output) this long.
export const CLOSED_KEEP_MS = 10 * 60 * 1000
// Panes open_terminal opens in one call.
export const MAX_OPEN_PANES = 4
// Settings > Agents > Terminals, "Background commands": 'one' (default): one
// terminal per agent, for its commands left running too; 'each': a terminal
// for each command left running.
export const BACKGROUND_MODES = ['one', 'each']

// Where a pane opened for an agent goes in its grid (a new tree): the first
// one beside `anchorId` (the agent), the next ones stacked with the others
// of its group as equal rows (addPageNear: the agent's pane keeps its room
// instead of being halved each time). mine(leaf): a pane of that group
// (`leaf` itself excluded); makeSplit(dir, children, sizes) -> a split node.
export function placeNear(tree, anchorId, leaf, { forEachLeaf, mine, makeSplit }) {
  let last = null
  forEachLeaf(tree, (l) => l !== leaf && mine(l) && (last = l))
  return addPageNear(tree, last ? last.id : anchorId, leaf, {
    dir: last ? 'col' : 'row',
    mine: (n) => n === leaf || (n.type === 'leaf' && mine(n)),
    makeSplit
  })
}
// An agent's own terminals ("Ada · terminal", "Ada · terminal 2").
export const ownTerminalOf = (agentId) => (l) => l.kind !== 'browser' && l.openedBy === agentId

// deps:
//   enabled() -> bool
//   workspaces() -> [ws]; forEachLeaf(tree, fn)
//   getPane(id) -> the pane's API (TerminalPane.vue) | null
//   paneLabel(leaf), hostLabel(hostId), agentName(leaf)
//   agentYolo(agentLeaf) -> bool       the agent's pane runs in Yolo (paneRunsYolo)
//   userTyping(id) -> bool
//   hosts() -> [{ id, label, connected }]   SSH hosts whose shared connection is signed in
//   createTerminal({ agentLeaf, ws, hostId, number }) -> Promise<leaf | null>  (named "Ada · terminal")
//   closeTerminal(id)
//   activeTerminal() -> leaf | null    the user's active pane, when a terminal
//   approve(card) -> Promise<{ allow, command, action, remember }>
//   dismissApprovals(agentPane): its approval cards are answered no
//   notifyAgent(agentLeaf, text)       a notice in its inbox
//   toast(text, opts)
//   stoppedNotice({ agentLeaf, agentLabel, leaf, name })
//   writePty(id, data)
//   sleep(ms)
//   backgroundMode() -> 'one' | 'each'   (Settings > Agents > Terminals)
//   agentList() -> [{ id, name }]   the agents open_terminal may open
//   openPolicy(agentLeaf) -> { skipApproval, max }   a team lead whose workers start without asking
//   openPanes({ agentLeaf, ws, kind, agent, name, count, hostId }) -> Promise<[leaf]>
//   now() -> ms
// Does this agent pane run in Yolo, from how Tessel launched it (never from
// anything the agent says)? A terminal agent: started with its Yolo flags
// (launchYolo: the pane's own choice, Yolo folders, Settings > Agents), not
// Claude Code fallen back to Accept edits as root on an SSH host. A chat: its
// permissions now are Yolo (they follow its mode switches), never a worker
// capped to Ask first.
export function paneRunsYolo(leaf) {
  if (!leaf || typeof leaf !== 'object') return false
  if (leaf.kind === 'chat') return leaf.chatPermissions === 'yolo' && leaf.maxPermissions !== 'manual'
  if (leaf.kind === 'agent') return leaf.launchYolo === true && leaf.rootNoYolo !== true
  return false
}

export function createAgentTerminalTargets(deps) {
  const sleep = deps.sleep || ((ms) => new Promise((r) => setTimeout(r, ms)))
  const now = deps.now || (() => Date.now())
  const oneTerminal = () => (typeof deps.backgroundMode === 'function' ? deps.backgroundMode() : 'one') !== 'each'
  // Terminals agents used: pane id -> { owner (agent pane, when its own), hostId,
  // role: 'foreground' | 'background', exec, lastExec, number, extra (opened
  // for a command left running, or while its terminal was busy: it closes
  // when that command ends), touched (the user used it: it stays) }
  const terms = new Map()
  // An agent's terminals that closed: pane id -> { agentPane, name, command,
  // exitCode, output, until } (get_terminal_output still reads them).
  const closed = new Map()
  let execSeq = 0

  function keptFor(agentPane, ref) {
    const t = now()
    for (const [id, k] of closed) if (k.until <= t) closed.delete(id)
    const id = typeof ref === 'string' ? ref.trim() : null
    const k = id ? closed.get(id) : null
    return k && k.agentPane === agentPane && !find(id) ? k : null
  }
  // Its last command's output, kept for CLOSED_KEEP_MS after its pane goes.
  function keepOutput(id, s) {
    if (!s || !s.owner) return
    const exec = s.lastExec
    let output = ''
    let name = id
    try {
      const f = find(id)
      if (f) name = deps.paneLabel(f.leaf)
      const pane = deps.getPane(id)
      const t = pane && typeof pane.agentAdapter === 'function' ? pane.agentAdapter() : null
      if (t && exec && exec.startMarker && !exec.startMarker.isDisposed && exec.startMarker.line >= 0) output = t.getOutput(exec.startMarker, null)
      else if (pane && typeof pane.readText === 'function') output = pane.readText(MAX_READ_LINES)
    } catch {
      /* nothing to keep */
    }
    closed.set(id, {
      agentPane: s.owner,
      name,
      command: exec ? exec.command : null,
      exitCode: exec && exec.done && exec.result ? exec.result.exitCode : undefined,
      output: String(output || ''),
      until: now() + CLOSED_KEEP_MS
    })
  }
  // Closes one of an agent's own terminals, its output kept.
  function closeOwn(id) {
    const s = terms.get(id)
    keepOutput(id, s)
    if (s && s.offTouch) s.offTouch()
    terms.delete(id)
    deps.closeTerminal(id)
  }
  // The user used this terminal (clicked into it, typed, resized or moved
  // it): it stays open.
  function touch(id) {
    const s = terms.get(id)
    if (s) s.touched = true
  }

  function find(paneId) {
    for (const ws of deps.workspaces()) {
      let hit = null
      deps.forEachLeaf(ws.tree, (l) => {
        if (!hit && l.id === paneId) hit = l
      })
      if (hit) return { ws, leaf: hit }
    }
    return null
  }

  function agentOf(paneId) {
    if (typeof paneId !== 'string' || !paneId) throw refuse('not_agent', 'Unknown pane.') // i18n-ignore
    const found = find(paneId)
    if (!found) throw refuse('not_agent', 'Your pane is not open in Tessel.') // i18n-ignore
    if (found.leaf.kind !== 'agent' && found.leaf.kind !== 'chat') throw refuse('not_agent', 'Only an agent pane may use the terminal tools.') // i18n-ignore
    return found
  }

  const isTerminal = (l, me) => l && l.type === 'leaf' && l.id !== me.id && (l.kind === 'shell' || l.kind === 'agent')
  const ownBy = (id, agentPane) => {
    const s = terms.get(id)
    return !!s && s.owner === agentPane
  }

  // The shell's language for rules: PowerShell or bash-like.
  // The language the rules read a terminal's commands in: PowerShell, bash
  // (bash and zsh), or unknown (cmd, an SSH host's or WSL's shell until it
  // says it is bash or zsh): an unknown shell's commands are always asked.
  function shellOf(leaf) {
    const id = String(leaf.shellId || '')
    let reported = null
    try {
      const pane = deps.getPane(leaf.id)
      const t = pane && typeof pane.agentAdapter === 'function' ? pane.agentAdapter() : null
      reported = t ? t.shell.state().shell || null : null
    } catch {
      reported = null
    }
    const posix = reported === 'bash' || reported === 'zsh'
    if (leaf.remoteHostId) return { lang: posix ? 'bash' : 'unknown', shellKind: 'ssh' }
    if (id === 'pwsh' || id === 'powershell') return { lang: 'powershell', shellKind: id }
    if (id === 'gitbash') return { lang: 'bash', shellKind: id }
    return { lang: posix ? 'bash' : 'unknown', shellKind: id || 'unknown' }
  }
  const workspaceKey = (ws) => String((ws.remote && `${ws.remote.hostId}:${ws.remote.path}`) || ws.cwd || ws.id || '')

  function describe(l, ws, agentWs, agentLeaf) {
    const pane = deps.getPane(l.id)
    let busy = null
    try {
      const t = pane && typeof pane.agentAdapter === 'function' ? pane.agentAdapter() : null
      if (t && t.shell.quality() !== 'none') busy = t.shell.executing()
    } catch {
      busy = null
    }
    const s = terms.get(l.id)
    if (s && s.exec && !s.exec.done) busy = true
    return {
      id: l.id,
      num: l.num || null,
      name: deps.paneLabel(l),
      kind: l.kind === 'agent' ? 'agent' : 'shell',
      agentName: l.kind === 'agent' ? deps.agentName(l) : null,
      host: l.remoteHostId ? deps.hostLabel(l.remoteHostId) : null,
      folder: String(l.cwd || l.remotePath || l.startDir || ws.cwd || (ws.remote && ws.remote.path) || '').slice(0, 300),
      workspace: String(ws.name || '').slice(0, 100),
      workspaceKey: workspaceKey(ws),
      sameWorkspace: ws === agentWs,
      busy,
      notConnected: !!l.notConnected,
      exited: !!l.exited,
      ready: !!pane,
      own: ownBy(l.id, agentLeaf.id),
      // The calling agent's pane runs in Yolo (its own terminals then run
      // without a card, src/main/agentTerminal.js).
      agentYolo: typeof deps.agentYolo === 'function' ? deps.agentYolo(agentLeaf) === true : false,
      // On the host of the agent's project (this computer for a local project)?
      projectHost: (l.remoteHostId || null) === ((agentWs.remote && agentWs.remote.hostId) || null),
      ...shellOf(l)
    }
  }

  function terminalsOf(agentWs, agentLeaf, all) {
    const out = []
    for (const ws of all ? deps.workspaces() : [agentWs]) deps.forEachLeaf(ws.tree, (l) => isTerminal(l, agentLeaf) && out.push({ ws, leaf: l }))
    return out
  }

  // "pane-12", 3, "#3", "3" or a name: its own project first, then the others.
  function resolve(agentWs, agentLeaf, ref) {
    const raw = typeof ref === 'number' ? String(ref) : String(ref == null ? '' : ref).trim()
    if (!raw) throw refuse('invalid_argument', 'Give the terminal "id" (from run_in_terminal or terminal_list).') // i18n-ignore
    const all = terminalsOf(agentWs, agentLeaf, true)
    const mine = all.filter((x) => x.ws === agentWs)
    const byId = all.find((x) => x.leaf.id === raw)
    if (byId) return byId
    const self = find(raw)
    if (self && self.leaf.id === agentLeaf.id) throw refuse('own_pane', 'That is your own pane.') // i18n-ignore
    if (self) throw refuse('not_terminal', 'That pane is not a terminal.') // i18n-ignore
    const num = /^#?\d{1,4}$/.test(raw) ? Number(raw.replace('#', '')) : null
    if (num != null) {
      const hit = mine.find((x) => x.leaf.num === num)
      if (hit) return hit
    }
    const lower = raw.toLowerCase()
    for (const list of [mine, all]) {
      const hits = list.filter((x) => String(deps.paneLabel(x.leaf)).toLowerCase() === lower)
      if (hits.length === 1) return hits[0]
      if (hits.length > 1) throw refuse('ambiguous', `Several terminals are named "${raw.slice(0, 60)}": give its id from terminal_list.`) // i18n-ignore
    }
    if (keptFor(agentLeaf.id, raw)) throw refuse('terminal_closed', `Terminal ${raw.slice(0, 60)} closed after its command ended. Its last output is still readable with get_terminal_output for a few minutes; run_in_terminal opens a terminal again.`) // i18n-ignore
    throw refuse('terminal_not_found', `No terminal "${raw.slice(0, 60)}". Its id is the one run_in_terminal returned, or see terminal_list.`) // i18n-ignore
  }

  function adapterOf(leaf) {
    const pane = deps.getPane(leaf.id)
    if (!pane || typeof pane.agentAdapter !== 'function') throw refuse('not_ready', `"${deps.paneLabel(leaf)}" is not shown yet: ask the user to open its project once.`) // i18n-ignore
    const t = pane.agentAdapter()
    if (!t) throw refuse('not_ready', `"${deps.paneLabel(leaf)}" is not ready yet.`) // i18n-ignore
    return { pane, t }
  }

  // --- The agent's own terminals -------------------------------------------------------
  function hostOf(agentLeaf, ws, host) {
    if (host == null || host === '') {
      // An agent in a project on an SSH host: its terminals are there.
      return ws.remote ? ws.remote.hostId : null
    }
    const raw = String(host).trim().toLowerCase()
    if (raw === 'local' || raw === 'localhost' || raw === 'this computer') return null
    const list = deps.hosts()
    const hit = list.find((h) => h.id.toLowerCase() === raw || String(h.label || '').toLowerCase() === raw)
    if (!hit) throw refuse('host_not_found', `No SSH host "${String(host).slice(0, 60)}" in Tessel (Settings > SSH Hosts): ${list.map((h) => h.label || h.id).join(', ') || 'none'}.`) // i18n-ignore
    if (!hit.connected) throw refuse('host_not_connected', `Tessel is not signed in to "${hit.label || hit.id}" yet: ask the user to open a terminal on it once (it may ask for a password).`) // i18n-ignore
    return hit.id
  }

  function ownTerminals(agentPane) {
    const out = []
    for (const [id, s] of terms) {
      if (s.owner !== agentPane) continue
      const f = find(id)
      if (!f || f.leaf.exited) {
        terms.delete(id)
        continue
      }
      out.push({ id, s, leaf: f.leaf, ws: f.ws })
    }
    return out
  }

  async function waitReady(leaf, kind) {
    const until = Date.now() + READY_TIMEOUT_MS
    let t = null
    while (Date.now() < until) {
      const pane = deps.getPane(leaf.id)
      t = pane && typeof pane.agentAdapter === 'function' ? pane.agentAdapter() : null
      if (t && t.hasOutput()) break
      await sleep(100)
    }
    if (!t) throw refuse('not_ready', 'Your terminal did not start in time.') // i18n-ignore
    await Promise.race([waitForIdle(t, 500), sleep(5000)])
    const line = initLineFor(kind)
    if (line) {
      // The shell integration and the variables, then wait for its prompt.
      const seen = new Promise((resolve) => {
        const off = t.shell.onSequence((type) => {
          if (type === 'A' || type === 'B') {
            off()
            resolve()
          }
        })
        sleep(8000).then(() => {
          off()
          resolve()
        })
      })
      t.sendText(line)
      await seen
      await Promise.race([waitForIdle(t, 300), sleep(3000)])
    }
    return t
  }

  // The terminal for a command of this agent, on this host:
  // - One terminal per agent (the default): its terminal, for sync and async
  //   commands alike, when it is free. While a command it left running (a dev
  //   server) holds it, the next command opens one more terminal rather than
  //   wait behind a process that may never end; that extra one closes by
  //   itself once a command left running there ends.
  // - A terminal each: sync commands reuse its foreground terminal; each
  //   async command opens one, which closes once its command ends.
  async function ownTerminal(agentLeaf, ws, hostId, mode, mayOpen = true) {
    const one = oneTerminal()
    const mine = ownTerminals(agentLeaf.id).filter((x) => !x.s.retired && (x.s.hostId || null) === (hostId || null))
    const idle = (x) => !x.s.exec || x.s.exec.done
    const reuse = mode !== 'async' || one
    if (reuse) {
      const fg = mine.find((x) => x.s.role === 'foreground' && idle(x))
      if (fg) return { ...fg, isNew: false }
      // A terminal whose command ended becomes the foreground one.
      const free = mine.find((x) => idle(x))
      if (free) {
        free.s.role = 'foreground'
        return { ...free, isNew: false }
      }
    }
    const busy = reuse ? mine.find((x) => !idle(x)) : null
    // Too many new terminals lately (the main process counts them).
    if (!mayOpen) throw refuse('rate_limited', 'You opened too many terminals lately: wait a minute, or use one you have (terminal_list).') // i18n-ignore
    const all = ownTerminals(agentLeaf.id)
    if (all.length >= MAX_OWN_TERMINALS) {
      const old = all.find((x) => idle(x) && x.s.role === 'background') || all.find(idle)
      if (!old) throw refuse('too_many_terminals', `You already have ${MAX_OWN_TERMINALS} terminals running commands: wait for one, or close one with kill_terminal.`) // i18n-ignore
      closeOwn(old.id)
    }
    const left = ownTerminals(agentLeaf.id)
    let number = 1
    while (left.some((x) => x.s.number === number)) number++
    const leaf = await deps.createTerminal({ agentLeaf, ws, hostId, number })
    if (!leaf) throw refuse('open_failed', 'Tessel could not open a terminal for you.') // i18n-ignore
    const s = {
      owner: agentLeaf.id,
      hostId: hostId || null,
      role: mode === 'async' ? 'background' : 'foreground',
      exec: null,
      lastExec: null,
      number,
      extra: mine.length > 0 || (mode === 'async' && !one),
      touched: false
    }
    terms.set(leaf.id, s)
    const t = await waitReady(leaf, shellOf(leaf).shellKind)
    // The user typed in it: it stays open.
    if (t && typeof t.onUserInput === 'function') s.offTouch = t.onUserInput(() => (s.touched = true))
    const f = find(leaf.id)
    const busyWith = busy ? { id: busy.id, name: deps.paneLabel(busy.leaf), command: String(busy.s.exec.command || '').slice(0, 200) } : null
    return { id: leaf.id, s, leaf, ws: f ? f.ws : ws, isNew: true, busyWith }
  }

  // --- Running a command ---------------------------------------------------------------
  function noticeOf(agentLeaf, id, name) {
    return (text) => deps.notifyAgent(agentLeaf, `[Terminal ${id} (${name}) notification: ${text}`) // i18n-ignore
  }

  // Does this terminal close by itself now that this command ended? An extra
  // terminal of the agent's (never its reused one, never the user's), a
  // command left running or async, really ended (the shell said so: without
  // shell integration, quiet is not an end), the user never used it.
  function autoCloses(s, exec, r) {
    if (!s.owner || !s.extra || s.touched || s.retired) return false
    if (!exec.background && exec.mode !== 'async') return false
    if (!r || r.cancelled || r.didEnterAltBuffer || (r.error && r.output === undefined)) return false
    return r.strategy === 'rich' || r.strategy === 'basic'
  }

  // Runs a command line and waits as the mode says. -> the result for main.
  async function run(agentLeaf, target, { command, mode, timeoutMs, own }) {
    const { leaf } = target
    const name = deps.paneLabel(leaf)
    const { t } = adapterOf(leaf)
    let s = terms.get(leaf.id)
    if (!s) {
      s = { owner: null, hostId: leaf.remoteHostId || null, role: 'user', exec: null, lastExec: null }
      terms.set(leaf.id, s)
    }
    if (s.exec && !s.exec.done) throw refuse('terminal_busy', `A command is still running in "${name}" (${s.exec.command.slice(0, 80)}): wait for it, or use another terminal.`) // i18n-ignore
    if (!own && deps.userTyping(leaf.id)) throw refuse('user_typing', `The user is typing in "${name}": try again in a moment.`) // i18n-ignore
    let cancel
    const cancelled = new Promise((r) => (cancel = r))
    const exec = { id: ++execSeq, agentPane: agentLeaf.id, command, mode, startMarker: null, done: false, result: null, cancel, notified: false, background: false }
    s.exec = exec
    s.lastExec = exec
    let typedByUser = false
    const offInput = t.onUserInput(() => (typedByUser = true))
    // The agent's own terminal: a leading space keeps it out of the shell's history.
    const line = own ? ` ${command}` : command
    const promise = executeCommand(t, line, {
      cancelled,
      hasUserInput: () => own && typedByUser,
      onStartMarker: (m) => (exec.startMarker = m)
    })
      .then(
        (r) => r,
        (err) => ({ output: undefined, error: String((err && err.message) || err), exitCode: undefined })
      )
      .then((r) => {
        exec.done = true
        exec.result = r
        offInput()
        // Left running (timed out, async): the agent hears when it ends, if
        // the shell says so (VS Code notifies only with command detection).
        if (exec.background && !r.cancelled && t.shell.quality() !== 'none') {
          // A short notice only (it goes through the team channel's files):
          // the agent reads the output itself with get_terminal_output.
          const code = Number.isInteger(r.exitCode) ? ` with exit code ${r.exitCode}` : '' // i18n-ignore
          const closes = autoCloses(s, exec, r) ? ' The terminal closes by itself; its output stays readable there for 10 minutes.' : '' // i18n-ignore
          noticeOf(agentLeaf, leaf.id, name)(`command completed${code}.]\nCommand: ${command.slice(0, 300)}\nRead its output with get_terminal_output with id="${leaf.id}".${closes}`) // i18n-ignore
        }
        // A terminal opened for a command left running: it goes once that
        // command ended (when the shell says so), unless the user used it.
        if (autoCloses(s, exec, r))
          sleep(AUTO_CLOSE_MS).then(() => {
            if (terms.get(leaf.id) === s && s.exec === exec && !s.touched && find(leaf.id)) closeOwn(leaf.id)
          })
        return r
      })
    exec.promise = promise
    const input = watchForInput(t, { command })
    const limit = Math.max(1000, Number(timeoutMs) || 120000)
    let timer
    const timeout = new Promise((r) => (timer = setTimeout(() => r({ type: 'timeout' }), limit)))
    let raced
    try {
      if (mode === 'async') {
        // Until it first goes quiet (a server's banner), at most the timeout.
        const firstIdle = (async () => {
          await sleep(300)
          await waitForIdle(t, ASYNC_IDLE_MS)
          return { type: 'idle' }
        })()
        raced = await Promise.race([promise.then((r) => ({ type: 'done', r })), firstIdle, timeout, input.promise.then((k) => ({ type: k }))])
      } else {
        raced = await Promise.race([promise.then((r) => ({ type: 'done', r })), timeout, input.promise.then((k) => ({ type: k }))])
      }
    } finally {
      clearTimeout(timer)
      input.stop()
    }
    const outputNow = () => (exec.startMarker ? t.getOutput(exec.startMarker, null) : '')
    if (raced.type === 'done') {
      const r = raced.r
      if (r.error && r.output === undefined && !r.didEnterAltBuffer) throw refuse('terminal_gone', `"${name}": ${r.error}`) // i18n-ignore
      return { id: leaf.id, name, state: r.didEnterAltBuffer ? 'alternateBuffer' : r.cancelled ? 'cancelled' : 'completed', output: r.output || '', exitCode: r.exitCode, additionalInformation: r.additionalInformation, strategy: r.strategy }
    }
    // Still running: it becomes a background terminal, the agent gets its id.
    exec.background = true
    if (s.role === 'foreground') s.role = 'background'
    if (raced.type === 'sensitive') {
      deps.toast({ kind: 'sensitive', agentLeaf, leaf, name })
      return { id: leaf.id, name, state: 'sensitive', output: outputNow(), prompt: getLastLine(outputNow()), strategy: t.shell.quality() }
    }
    return { id: leaf.id, name, state: raced.type === 'input' ? 'input' : raced.type === 'idle' || mode === 'async' ? 'background' : 'timeout', output: outputNow(), strategy: t.shell.quality() }
  }

  // The user's Stop on a terminal's badge: the command it waits on is let go;
  // the agent's own terminal is not used for its commands again (a new one
  // is opened next time, its commands approved as always).
  function cancelPane(paneId) {
    const s = terms.get(paneId)
    if (s && s.owner) s.retired = true
    if (!s || !s.exec || s.exec.done) return false
    s.exec.cancel()
    // The agent's own terminal: what it ran is interrupted too.
    if (s.owner) deps.writePty(paneId, '\x03')
    return true
  }

  // --- The requests ---------------------------------------------------------------------
  // { agent, op, ... } -> the answer for src/main/agentTerminal.js
  async function handle(req = {}) {
    if (!deps.enabled()) throw refuse('disabled', 'The user turned off "Let agents use terminals" (Tessel Settings > Agents).') // i18n-ignore
    const { ws, leaf: agentLeaf } = agentOf(req.agent)
    const agentLabel = deps.paneLabel(agentLeaf)

    if (req.op === 'list') return { agent: agentLabel, terminals: terminalsOf(ws, agentLeaf, req.all === true).map((x) => describe(x.leaf, x.ws, ws, agentLeaf)) }

    // The user's active terminal (the main process asks the user before
    // reading it, then reads it by its id).
    if (req.op === 'active') {
      const leaf = deps.activeTerminal()
      if (!leaf || !isTerminal(leaf, agentLeaf)) return { none: true }
      const f = find(leaf.id)
      return { ...describe(leaf, f ? f.ws : ws, ws, agentLeaf), agentLabel }
    }

    if (req.op === 'lastCommand' || req.op === 'selection') {
      const leaf = req.terminal ? resolve(ws, agentLeaf, req.terminal).leaf : null
      if (!leaf) return { none: true }
      const { pane, t } = adapterOf(leaf)
      const name = deps.paneLabel(leaf)
      if (req.op === 'selection') return { name, text: String((pane.getSelection && pane.getSelection()) || '') }
      const c = t.shell.lastCommand()
      const running = t.shell.executing()
      if (!c) return { name, integration: t.shell.quality() !== 'none', running, text: null, screen: pane.readText(30) }
      return { name, integration: true, running, commandLine: c.commandLine, exitCode: c.exitCode, cwd: c.cwd, output: c.executedMarker && c.endMarker ? t.getOutput(c.executedMarker, c.endMarker) : null }
    }

    // run_in_terminal: the agent's own terminal, or one of the user's it names.
    // The agent's tool call went away: its approval cards go, the commands it
    // waits on are let go.
    if (req.op === 'abort') {
      deps.dismissApprovals(agentLeaf.id)
      for (const [id, s] of terms) if (s.exec && !s.exec.done && s.exec.agentPane === agentLeaf.id) cancelPane(id)
      return { ok: true }
    }

    // Which host a command of its own would run on, opening nothing.
    if (req.op === 'host') {
      const hostId = hostOf(agentLeaf, ws, req.host)
      return { hostId, label: hostId ? deps.hostLabel(hostId) : 'this computer', projectHost: (hostId || null) === ((ws.remote && ws.remote.hostId) || null) } // i18n-ignore
    }

    if (req.op === 'prepare') {
      if (req.terminal != null && req.terminal !== '') {
        const target = resolve(ws, agentLeaf, req.terminal)
        return { ...describe(target.leaf, target.ws, ws, agentLeaf), agentLabel, isNew: false }
      }
      const hostId = hostOf(agentLeaf, ws, req.host)
      const own = await ownTerminal(agentLeaf, ws, hostId, req.mode, req.mayOpen !== false)
      return { ...describe(own.leaf, own.ws, ws, agentLeaf), own: true, agentLabel, isNew: own.isNew, ...(own.busyWith ? { busyWith: own.busyWith } : {}) }
    }

    // A card about no terminal yet: another SSH host ("host:<id>"), panes to
    // open ("open:<agent pane>"); shown from the agent's own pane.
    if (req.op === 'approve' && typeof req.terminal === 'string' && /^(host|open):/.test(req.terminal))
      return plainAnswer(await deps.approve({ ...req.card, agentLeaf, agentLabel, leaf: agentLeaf, name: agentLabel, ws }))

    // open_terminal: what would open (the main process asks the user first).
    if (req.op === 'openInfo') return { agentLabel, ...openPlan(agentLeaf, ws, req) }
    if (req.op === 'open') {
      const plan = openPlan(agentLeaf, ws, req)
      const count = Math.min(plan.max, Math.max(1, Math.round(Number(req.count) || 1)))
      const label = String(req.name || '')
        .replace(/[\u0000-\u001f\u007f]/g, ' ')
        .trim()
        .slice(0, 60)
      const leaves = await deps.openPanes({ agentLeaf, ws, kind: plan.kind, agent: plan.agentId, name: label, count, hostId: plan.hostId })
      return { agentLabel, kind: plan.kind, agentName: plan.agentName, host: plan.host, panes: (leaves || []).filter(Boolean).map((l) => ({ id: l.id, name: deps.paneLabel(l) })) }
    }

    // A terminal of its own that closed (auto-closed, killed): its last output.
    const kept = req.op === 'output' || (req.op === 'resolve' && req.read) ? keptFor(agentLeaf.id, req.terminal) : null
    if (kept && req.op === 'resolve') return { id: String(req.terminal).trim(), name: kept.name, kind: 'shell', own: true, closed: true, agentLabel }
    if (kept) return { name: kept.name, command: kept.command, running: false, exitCode: kept.exitCode, output: kept.output, closed: true }

    const target = resolve(ws, agentLeaf, req.terminal)
    const { leaf } = target
    const name = deps.paneLabel(leaf)
    // Reading: only the terminals of the agent's own project.
    if ((req.op === 'output' || (req.op === 'resolve' && req.read)) && target.ws !== ws && !ownBy(leaf.id, agentLeaf.id))
      throw refuse('other_project', `"${name}" is in another project: you can only read the terminals of your own project.`) // i18n-ignore

    if (req.op === 'resolve') {
      const pane = deps.getPane(leaf.id)
      let appCursor = false
      let cursor = ''
      try {
        const t = pane && pane.agentAdapter ? pane.agentAdapter() : null
        appCursor = !!(t && t.appCursorKeys())
        cursor = t ? t.cursorLine() : ''
      } catch {
        appCursor = false
      }
      return { ...describe(leaf, target.ws, ws, agentLeaf), agentLabel, appCursor, cursorLine: cursor }
    }

    if (req.op === 'approve') return plainAnswer(await deps.approve({ ...req.card, agentLeaf, agentLabel, leaf, name, ws: target.ws }))

    if (req.op === 'stoppedNotice') {
      deps.stoppedNotice({ agentLeaf, agentLabel, leaf, name })
      return { ok: true }
    }

    if (req.op === 'run') {
      if (leaf.kind === 'agent') throw refuse('read_only', `"${name}" is an agent's pane: agents never type into each other (use team_send).`) // i18n-ignore
      return run(agentLeaf, target, { command: String(req.command || ''), mode: req.mode === 'async' ? 'async' : 'sync', timeoutMs: req.timeoutMs, own: ownBy(leaf.id, agentLeaf.id) })
    }

    if (req.op === 'output') {
      const s = terms.get(leaf.id)
      const exec = s && s.lastExec && s.lastExec.agentPane === agentLeaf.id ? s.lastExec : null
      const { pane, t } = adapterOf(leaf)
      if (exec && exec.startMarker && !exec.startMarker.isDisposed && exec.startMarker.line >= 0) {
        return { name, command: exec.command, running: !exec.done, exitCode: exec.done && exec.result ? exec.result.exitCode : undefined, output: t.getOutput(exec.startMarker, null) }
      }
      const lines = Math.min(MAX_READ_LINES, Math.max(1, Math.round(Number(req.lines) || 60)))
      return { name, command: null, running: null, output: pane.readText(lines) }
    }

    if (req.op === 'send') {
      if (leaf.kind === 'agent') throw refuse('read_only', `"${name}" is an agent's pane: agents never type into each other (use team_send).`) // i18n-ignore
      const own = ownBy(leaf.id, agentLeaf.id)
      if (!own && deps.userTyping(leaf.id)) throw refuse('user_typing', `The user is typing in "${name}": try again in a moment.`) // i18n-ignore
      const { t } = adapterOf(leaf)
      const start = t.registerMarker()
      if (req.mode === 'keys') t.write(String(req.data || ''))
      else t.sendText(String(req.data || ''))
      let output
      if (req.waitForOutput) {
        await sleep(300)
        await Promise.race([waitForIdle(t, 2000), sleep(SEND_WAIT_MAX_MS)])
        output = t.getOutput(start, null)
      } else {
        await sleep(SEND_SETTLE_MS)
        output = t
          .getOutput(start, null)
          .split('\n')
          .filter((l) => l.trim())
          .slice(-20)
          .join('\n')
      }
      return { name, output }
    }

    if (req.op === 'kill') {
      if (!ownBy(leaf.id, agentLeaf.id)) throw refuse('not_own', `"${name}" is not one of your terminals: only the user closes it.`) // i18n-ignore
      const s = terms.get(leaf.id)
      const out = s && s.lastExec && s.lastExec.startMarker ? adapterOf(leaf).t.getOutput(s.lastExec.startMarker, null) : ''
      if (s && s.exec && !s.exec.done) s.exec.cancel()
      closeOwn(leaf.id)
      return { name, output: out }
    }

    throw refuse('invalid_argument', 'Unknown request.') // i18n-ignore
  }

  function plainAnswer(r) {
    return {
      allow: !!(r && r.allow),
      command: r && typeof r.command === 'string' ? r.command : null,
      // A plain copy: the card's own objects are reactive, which IPC cannot clone.
      action: r && r.action ? JSON.parse(JSON.stringify(r.action)) : null,
      remember: r && r.remember === 'pane' ? 'pane' : 'once'
    }
  }

  // open_terminal: which panes, from the request and the caller. kind
  // 'agent' with no agent named: the caller's own agent (OpenCode opens
  // OpenCode). In the caller's project, on its SSH host when it is there.
  function openPlan(agentLeaf, ws, req) {
    const kind = req.kind === 'shell' ? 'shell' : req.kind === 'agent' || req.kind == null ? 'agent' : null
    if (!kind) throw refuse('invalid_argument', '"kind" must be "agent" (an agent session) or "shell" (a plain terminal).') // i18n-ignore
    let agentId = null
    let agentName = null
    if (kind === 'agent') {
      const list = typeof deps.agentList === 'function' ? deps.agentList() : []
      const want = String(req.agentId || agentLeaf.agentId || 'claude')
        .trim()
        .toLowerCase()
      const hit = list.find((a) => String(a.id).toLowerCase() === want || String(a.name || '').toLowerCase() === want)
      if (!hit) throw refuse('agent_not_found', `No agent "${want.slice(0, 40)}" in Tessel. Agents: ${list.map((a) => a.id).join(', ') || 'none'}.`) // i18n-ignore
      agentId = hit.id
      agentName = hit.name || hit.id
    }
    const policy = (typeof deps.openPolicy === 'function' && deps.openPolicy(agentLeaf)) || {}
    const max = Math.min(MAX_OPEN_PANES, Math.max(1, Number.isInteger(policy.max) ? policy.max : MAX_OPEN_PANES))
    const hostId = ws.remote ? ws.remote.hostId : null
    return { kind, agentId, agentName, hostId, host: hostId ? deps.hostLabel(hostId) : null, skipApproval: policy.skipApproval === true, max }
  }

  return {
    handle,
    resolve,
    find,
    cancelPane,
    touch,
    // Its pane closed (by the user, or here): an agent's own terminal keeps its output.
    forget: (id) => {
      const s = terms.get(id)
      if (s && s.owner && !closed.has(id)) keepOutput(id, s)
      if (s && s.offTouch) s.offTouch()
      terms.delete(id)
    },
    _terms: terms,
    _closed: closed
  }
}
