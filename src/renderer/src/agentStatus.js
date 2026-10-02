// Live agent state keyed by pane id, kept out of the layout tree so these flips
// never trigger a layout save.
//   agentStatus[id]  -> 'busy' | 'idle' | 'unknown'
//   attention[id]    -> true when an agent finished a stretch of work while you
//                       were looking elsewhere, i.e. it is waiting on you.
//   limits[id]       -> { reset } when the agent has hit its usage limit
//                       (see agentLimit.js); reset is its reset time or ''.
//   approvals[id]    -> true while the agent shows an approval prompt
//                       ("Would you like to run...", see agentLimit.js).
//   monitoring[id]   -> the number of background tasks (shells, sub-agents,
//                       monitors) still running after the agent ended its
//                       turn, by its own hooks (agentStateModel.js).
// The workspace sidebar reads both to badge workspaces.
import { reactive } from 'vue'
import { detectApproval, detectLimit } from './agentLimit'
import { promptShowsPlaceholder } from './promptCheck'
import { STATUS_PROVIDERS, SCREEN_READY_PROVIDERS } from '../../shared/agentStateModel'
import { freebuffScreenState } from '../../shared/freebuffScreen'

export const agentStatus = reactive({})
export const attention = reactive({})
export const limits = reactive({})
export const approvals = reactive({})
export const monitoring = reactive({})
// Main-process observations carry execution identity and freshness. Screen
// estimates remain useful for display but cannot authorize automatic actions.
export const agentStates = reactive({})

export function getAgentState(id, launchToken) {
  const state = agentStates[id]
  return state && (!launchToken || state.launchToken === launchToken) ? state : null
}

export function agentStateKnown(id, launchToken) {
  const state = getAgentState(id, launchToken)
  return !!(
    state?.confirmed &&
    state.hookSeen &&
    !state.stale &&
    !['unknown', 'closed'].includes(state.state)
  )
}

// Status from the agent's own hooks. Claude Code and Codex: from launch (their
// screen confirms when they are ready). The other agents with status hooks
// (agentStateModel.js): once their first hook arrived, so an agent whose hooks
// never run (an older CLI, hooks turned off) keeps its status from its screen.
export function managedAgentStatus(node) {
  if (!node || !node.agentLaunchToken) return false
  if (SCREEN_READY_PROVIDERS.includes(node.agentId)) return true
  const state = agentStates[node.id]
  return STATUS_PROVIDERS.includes(node.agentId) && !!state?.hookSeen && state.launchToken === node.agentLaunchToken
}
// A state that drives the pane's status (see managedAgentStatus).
const drives = (state) => SCREEN_READY_PROVIDERS.includes(state.provider) || !!state.hookSeen

function displayStatus(state) {
  if (!state || state.stale || state.confirmed === false) return 'unknown'
  if (state.state === 'working') return 'busy'
  if (['idle', 'approval', 'limited'].includes(state.state)) return 'idle'
  return 'unknown'
}

export function applyAgentStates(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return
  const entries = snapshot.paneId ? { [snapshot.paneId]: snapshot } : snapshot
  if (!snapshot.paneId) {
    for (const id of Object.keys(agentStates))
      if (!entries[id]) {
        const drove = drives(agentStates[id])
        delete agentStates[id]
        setMonitoring(id, 0)
        if (drove) agentStatus[id] = 'unknown'
      }
  }
  for (const [id, state] of Object.entries(entries)) {
    if (!state || state.paneId !== id || !state.launchToken) continue
    agentStates[id] = { ...state }
    // Not yet heard from its hooks: the screen keeps the status for now.
    if (!drives(state)) continue
    agentStatus[id] = displayStatus(state)
    setMonitoring(id, state.monitoring === true && Number.isInteger(state.backgroundTasks) ? state.backgroundTasks : 0)
    setApproval(id, state.state === 'approval')
    if (state.state === 'limited') setLimit(id, { reset: state.reset })
    else if (!state.stale && state.confirmed !== false) clearLimit(id)
  }
}

const FOOTER = /\besc(?:ape)?\s+(?:to\s+)?(?:interrupt|cancel)\b/i
const RUNNING = /\besc(?:ape)?\s+(?:to\s+)?interrupt\b/i
// Claude Code's working line, its spinner over its input box. Since 2.1.2xx
// it no longer says "esc to interrupt": a spinner glyph (· ✢ ✳ ✶ ✻ ✽, "*"
// on some terminals), its verb with "…", then maybe "(23s · ↓ 1.2k tokens ·
// thinking)", cut where a narrow pane wraps it. Its finished form ("✻ Worked
// for 23s") has no "…": not running.
const WORKING =
  /^\s*[·✢✳✶✻✽*]\s+[A-Za-z][^…()]{0,60}…(?:\s*\((?=[^)]*(?:\d+[hms]\b|\btokens?\b|\bthinking\b|\bthought for\b|\btool\b|\binterrupt\b))[^)]*\)?)?\s*$/
const workingLine = (text) => String(text || '').split(/\r?\n/).some((line) => WORKING.test(line))
const INTERRUPTED = /\bInterrupted\b\s*(?:by user|·\s*What should Claude do instead)/i
const RULE = /^[─━]{8,}$/
const rowText = (buffer, y) => (y >= 0 ? buffer.getLine(y)?.translateToString(true) || '' : '')
// A placeholder or hint: drawn dim, or in a colour (Claude Code draws its dim
// text in grey, not with the terminal's dim attribute). Typed text is plain.
const hintCell = (cell) =>
  !!cell && (cell.isDim() || (typeof cell.isFgDefault === 'function' && !cell.isFgDefault()))

// Claude Code's input line, where the cursor is: its prompt "❯", or ">" where
// the terminal is not known to show Unicode (Claude Code's fallback on
// Windows without Windows Terminal: every Tessel pane), then the cursor. A
// ">" line must sit under the input box's top rule ("────"): the same
// character starts quoted text and other programs' prompts.
// null: the cursor is not in Claude Code's input. empty: nothing typed (a
// placeholder at most).
function claudeInput(term) {
  const buffer = term.buffer.active
  const y = buffer.baseY + buffer.cursorY
  const line = buffer.getLine(y)
  const text = line?.translateToString(true) || ''
  const at = text.search(/\S/)
  if (at < 0 || !['❯', '>'].includes(text[at]) || buffer.cursorX <= at) return null
  if (text[at] === '>' && !RULE.test(rowText(buffer, y - 1).trim())) return null
  let typed = false
  for (let x = at + 1; x < text.length && !typed; x++) {
    const cell = line.getCell(x)
    if (cell && cell.getChars().trim() && !hintCell(cell)) typed = true
  }
  return { empty: !typed && buffer.cursorX <= at + 2 }
}

// How many images Claude Code (or OpenClaude) shows in its input box now: a
// pasted image path becomes "[Image #N]" there a moment later (deliver.js
// waits for each one before the next path, and before Enter). The box is the
// rows between its two rules ("────") around the cursor; text above it (the
// conversation) is never counted. null: the cursor is not in such a box.
// The agent wraps a long input itself, maybe between "[Image" and "#N]".
const IMAGE_MARKER = /\[Image\s+#\d+\]/g
export function claudeInputImages(term) {
  try {
    const buffer = term && term.buffer && term.buffer.active
    if (!buffer) return null
    const y = buffer.baseY + buffer.cursorY
    let top = -1
    for (let r = y; r >= Math.max(0, y - 40) && top < 0; r--) if (RULE.test(rowText(buffer, r).trim())) top = r
    if (top < 0 || top === y) return null
    const rows = []
    for (let r = top + 1; r <= y + 40; r++) {
      const line = buffer.getLine(r)
      if (!line) break
      const text = line.translateToString(true)
      if (r > y && RULE.test(text.trim())) break
      // A wrapped row continues the one above it: joined, so a marker cut by
      // the wrap still counts once.
      if (line.isWrapped && rows.length) rows[rows.length - 1] += text
      else rows.push(text)
    }
    const prompt = rows[0] ? rows[0].search(/\S/) : -1
    if (prompt < 0 || !['❯', '>'].includes(rows[0][prompt])) return null
    return (rows.join('\n').match(IMAGE_MARKER) || []).length
  } catch {
    return null
  }
}

// The same for Codex: its input has no rules, only its prompt "›" on its
// first row (a pasted image path shows as "[Image #N]" there too). Counted
// from the nearest "›" row at or above the cursor down to the cursor (the
// conversation's own "›" rows are above that one). null: no prompt found.
export function codexInputImages(term) {
  try {
    const buffer = term && term.buffer && term.buffer.active
    if (!buffer) return null
    const y = buffer.baseY + buffer.cursorY
    let start = -1
    for (let r = y; r >= Math.max(0, y - 40) && start < 0; r--) if (/^\s*›/.test(rowText(buffer, r))) start = r
    if (start < 0) return null
    let text = ''
    for (let r = start; r <= y; r++) text += (buffer.getLine(r)?.isWrapped ? '' : '\n') + rowText(buffer, r)
    return (text.match(IMAGE_MARKER) || []).length
  } catch {
    return null
  }
}

// The rows just above the cursor: Claude Code's spinner and its "esc to
// interrupt" sit right above its input box, while a tall status line under
// the box can push them out of the screen's last lines.
function aboveCursor(term, rows = 5) {
  const buffer = term.buffer.active
  const y = buffer.baseY + buffer.cursorY
  const out = []
  for (let i = rows; i >= 1; i--) out.push(rowText(buffer, y - i))
  return out.join('\n')
}

// Read the actual input cursor/cells, not a prompt-looking line in an answer.
// A visible input can remain underneath an active turn, so the running footer
// vetoes readiness. A main-process Stop candidate is still required for a
// completion: this observation alone cannot finish known hook work.
// ready: an empty input (automations wait for it). waiting: the agent waits
// at its input, maybe with a draft typed in it (its status: not running).
export function agentScreenObservation(term, provider, screen) {
  if (provider === 'freebuff') {
    const own = freebuffObservation(term, screen)
    if (own) return own
  }
  const approval = detectApproval(screen)
  const limit = detectLimit(screen)
  const footer = String(screen || '')
    .split(/\r?\n/)
    .slice(-8)
    .join('\n')
  // Claude Code's spinner can sit above a todo list over its input box.
  const near = term && provider === 'claude' ? aboveCursor(term, 14) : ''
  const spinner = provider === 'claude' && (workingLine(footer) || workingLine(near))
  const busy =
    spinner || FOOTER.test(footer) || (!!term && provider === 'claude' && FOOTER.test(aboveCursor(term)))
  // Running, not an approval's "esc to cancel" (the monitor clears an
  // answered approval on it).
  const running =
    spinner || RUNNING.test(footer) || (!!term && provider === 'claude' && RUNNING.test(aboveCursor(term)))
  let ready = false
  let waiting = false
  const prompt = provider === 'claude' ? '❯' : provider === 'codex' ? '›' : null
  if (term && provider === 'claude' && !approval && !limit && !busy) {
    const input = claudeInput(term)
    ready = !!input?.empty
    waiting = !!input
  } else if (term && prompt && !approval && !limit && !busy) {
    ready = promptShowsPlaceholder(term, prompt)
    if (!ready) {
      const buffer = term.buffer.active
      const line = buffer.getLine(buffer.baseY + buffer.cursorY)
      const text = line?.translateToString(true) || ''
      const at = text.indexOf(prompt)
      ready =
        at >= 0 &&
        !text.slice(0, at).trim() &&
        !text.slice(at + prompt.length).trim() &&
        buffer.cursorX === at + prompt.length + 1
    }
    waiting = ready
  }
  // Claude Code runs no hook when its turn is interrupted (Esc): it says so
  // just above its prompt ("⎿  Interrupted · What should Claude do instead?"),
  // Codex too ("■ Conversation interrupted - tell the model what to do
  // differently"). A status line can sit below the prompt: a few more lines.
  const above = String(screen || '')
    .split(/\r?\n/)
    .slice(-16)
  const interruption = provider === 'claude' && waiting ? lastInterruption(above) : null
  const interrupted =
    waiting &&
    (!!interruption || (provider === 'codex' && /\bConversation interrupted\b/i.test(above.join('\n'))))
  return {
    screen,
    approval,
    limit,
    busy,
    running,
    ready,
    waiting,
    interrupted,
    // Which "Interrupted" line it is (the monitor reports each one once per
    // turn), and what the input line holds now (deliver.js: an input Enter
    // emptied is a message taken). null: not known.
    interruption,
    input: inputState(term, provider)
  }
}

// Freebuff (no hooks): its own screen, read whole (a question dialog can be
// taller than the lines near the cursor). null: nothing of its own shown.
function freebuffObservation(term, screen) {
  let state = null
  try {
    const buffer = term?.buffer?.active
    if (!buffer) return null
    const lines = []
    for (let y = buffer.viewportY; y < buffer.viewportY + term.rows; y++) lines.push(rowText(buffer, y))
    state = freebuffScreenState(lines, buffer.type === 'alternate')?.state || null
  } catch {
    return null
  }
  if (!state) return null
  const waiting = state === 'waiting' || state === 'blocked'
  return {
    screen,
    approval: waiting,
    limit: detectLimit(screen),
    busy: state === 'working',
    running: state === 'working',
    ready: state === 'ready',
    waiting: state === 'ready',
    interrupted: false,
    interruption: null,
    input: null
  }
}

// Claude Code's "Interrupted" line, only when it is the last thing above its
// input box (blank rows and the box's rules apart). An older one, from a
// turn before the latest prompt, has that prompt, its tool calls and its
// spinner under it: it says nothing of the turn running now. -> that line
// with the one above it (to tell one interruption from the next), or null.
function lastInterruption(lines) {
  let input = -1
  for (let i = lines.length - 1; i >= 0 && input < 0; i--) if (/^\s*[❯>]/.test(lines[i])) input = i
  for (let i = input - 1; i >= 0; i--) {
    const text = lines[i].trim()
    if (!text || RULE.test(text)) continue
    return INTERRUPTED.test(text) ? `${i > 0 ? lines[i - 1].trim() : ''}\n${text}` : null
  }
  return null
}

// 'empty' | 'draft' | null: Claude Code's input at the cursor (a placeholder
// counts as empty), Codex's "›" line, whatever the agent is doing.
function inputState(term, provider) {
  if (!term) return null
  try {
    if (provider === 'claude') {
      const input = claudeInput(term)
      return input ? (input.empty ? 'empty' : 'draft') : null
    }
    if (provider === 'codex') {
      if (promptShowsPlaceholder(term, '›')) return 'empty'
      const buffer = term.buffer.active
      const text = buffer.getLine(buffer.baseY + buffer.cursorY)?.translateToString(true) || ''
      const at = text.indexOf('›')
      if (at < 0 || text.slice(0, at).trim()) return null
      return text.slice(at + 1).trim() ? 'draft' : 'empty'
    }
  } catch {
    // A terminal being torn down: not known.
  }
  return null
}

// Shared by TerminalPane and clock-driven tests. Hook state owns the result;
// output schedules a screen observation, never a synthetic successful Stop.
export function createAgentActivityMonitor({
  getNode,
  readScreen,
  report,
  onStatus,
  onWorking,
  onCompleted,
  onApproval,
  onLimit,
  now = Date.now
}) {
  const IDLE_MS = 1400
  const WORK_MS = 4000
  let timer = null
  let workTimer = null
  let busySince = 0
  let localStatus = 'idle'
  let previous = null
  let lastCompleted = 0
  let disposed = false
  let lastRecheck = 0
  // An approval this pane's screen reported (not its hooks): for an agent with
  // no ready prompt to read, its disappearing from the screen is the answer.
  let screenApproval = false
  function status(value) {
    localStatus = value
    onStatus(value)
  }
  function send(event, extra = {}) {
    const node = getNode()
    if (!managedAgentStatus(node)) return
    try {
      report?.({ paneId: node.id, launchToken: node.agentLaunchToken, event, ...extra })
    } catch {
      // An unavailable observer must never break terminal rendering/input.
    }
  }
  // The hooks win while a turn they opened runs (UserPromptSubmit,
  // PreToolUse, no Stop yet): an "Interrupted" line this pane already saw
  // before that turn began is the old turn's, still in view, and never ends
  // the new one.
  let seenInterruption = null // { key, at }
  function freshInterruption(node, observation) {
    if (!observation.interrupted) return false
    const key = observation.interruption
    if (!key) return true
    const state = getAgentState(node.id, node.agentLaunchToken)
    const hookTurn =
      !!state?.hookSeen && state.source === 'hook' && ['working', 'approval'].includes(state.state)
    if (seenInterruption?.key === key) return !(hookTurn && state.since > seenInterruption.at)
    seenInterruption = { key, at: now() }
    return true
  }
  function screenCheck() {
    if (disposed) return
    const node = getNode()
    const observation = readScreen()
    const managed = managedAgentStatus(node)
    if (observation.limit) {
      onLimit(observation.limit)
      if (managed) send('ScreenLimit', { reset: observation.limit.reset })
      return observation
    }
    if (observation.approval) {
      onApproval(true)
      if (managed) {
        send('ScreenApproval')
        screenApproval = true
      }
      return observation
    }
    if (managed && screenApproval && !SCREEN_READY_PROVIDERS.includes(node.agentId)) {
      screenApproval = false
      onApproval(false)
      send('ScreenClearApproval')
      return observation
    }
    if (managed) {
      // Absence of matching text is not proof that a hook approval ended.
      // At its input, a draft typed or not: not running.
      if (observation.ready || observation.waiting) {
        const hadApproval =
          approvals[node.id] || getAgentState(node.id, node.agentLaunchToken)?.state === 'approval'
        onApproval(false)
        if (hadApproval) send('ScreenClearApproval')
        send(freshInterruption(node, observation) ? 'ScreenInterrupted' : 'ScreenReady')
      } else if (observation.busy) {
        // Working again ("esc to interrupt", never an approval's "esc to
        // cancel") with no approval on screen: the approval was answered.
        const hadApproval =
          approvals[node.id] || getAgentState(node.id, node.agentLaunchToken)?.state === 'approval'
        const running =
          observation.running ??
          RUNNING.test(String(observation.screen || '').split(/\r?\n/).slice(-8).join('\n'))
        if (hadApproval && running) {
          onApproval(false)
          send('ScreenClearApproval')
        }
        send('ScreenBusy')
      }
    } else onApproval(false)
    return observation
  }
  function checkIdle() {
    timer = null
    if (disposed) return
    const node = getNode()
    const observation = screenCheck()
    if (managedAgentStatus(node)) {
      status(displayStatus(getAgentState(node.id, node.agentLaunchToken)))
      return
    }
    status('idle')
    clearTimeout(workTimer)
    const worked = now() - busySince - IDLE_MS
    if (observation.approval || observation.limit) return
    if (worked >= WORK_MS) onCompleted({ at: now(), screen: observation.screen, estimated: true })
  }
  function schedule() {
    clearTimeout(timer)
    timer = setTimeout(checkIdle, IDLE_MS)
  }
  return {
    output({ redraw = false } = {}) {
      if (disposed) return
      const node = getNode()
      if (managedAgentStatus(node)) {
        status(displayStatus(getAgentState(node.id, node.agentLaunchToken)))
        // Redraws can reveal readiness, but are never work/completion evidence.
        schedule()
        if (now() - lastRecheck > 1000) {
          lastRecheck = now()
          screenCheck()
        }
        return
      }
      if (redraw) return
      if ((approvals[node.id] || limits[node.id]) && now() - lastRecheck > 1000) {
        lastRecheck = now()
        const observation = readScreen()
        if (!observation.approval) onApproval(false)
        if (!observation.limit) clearLimit(node.id)
      }
      if (localStatus !== 'busy') {
        busySince = now()
        clearTimeout(workTimer)
        workTimer = setTimeout(() => onWorking({ estimated: true }), WORK_MS)
      }
      status('busy')
      schedule()
    },
    stateChanged(state) {
      if (disposed || !managedAgentStatus(getNode())) return
      const token = getNode().agentLaunchToken
      if (state?.launchToken !== token) state = null
      status(displayStatus(state))
      const sameExecution = previous && previous.launchToken === state?.launchToken
      const changed =
        !sameExecution ||
        previous.observedAt !== state?.observedAt ||
        previous.state !== state?.state ||
        previous.reason !== state?.reason
      if (!sameExecution) lastCompleted = state?.turnCompletedAt || 0
      if (state?.confirmed && !state.stale && state.hookSeen) {
        if (state.state === 'working' && (!sameExecution || previous.state !== 'working'))
          onWorking({ estimated: false })
        if (state.state === 'idle' && state.turnCompletedAt > lastCompleted) {
          lastCompleted = state.turnCompletedAt
          onCompleted({ at: state.turnCompletedAt, screen: readScreen().screen, estimated: false })
        }
      }
      previous = state ? { ...state } : null
      if (state?.state === 'closed') {
        clearTimeout(timer)
        clearTimeout(workTimer)
      } else if (
        changed &&
        (state?.reason === 'settling' || state?.reason === 'decision' || state?.state === 'unknown')
      )
        schedule()
    },
    dispose() {
      disposed = true
      clearTimeout(timer)
      clearTimeout(workTimer)
    }
  }
}

// Its turn ended by its own hooks while its background work still runs.
export function paneMonitoring(leaf) {
  return !!leaf && managedAgentStatus(leaf) && agentStatus[leaf.id] === 'idle' && monitoring[leaf.id] > 0
}

export function setApproval(id, on) {
  if (on) approvals[id] = true
  else if (approvals[id]) delete approvals[id]
}

export function setMonitoring(id, count) {
  if (count > 0) {
    if (monitoring[id] !== count) monitoring[id] = count
  } else if (monitoring[id]) delete monitoring[id]
}

export function setLimit(id, info) {
  // Keep a reset time already known when this read of the screen shows none.
  const reset = (info && info.reset) || (limits[id] && limits[id].reset) || ''
  limits[id] = { reset }
}

export function clearLimit(id) {
  if (limits[id]) delete limits[id]
}

export function setAgentStatus(id, status, launchToken) {
  const state = getAgentState(id, launchToken)
  if (state?.hookSeen) status = displayStatus(state)
  if (agentStatus[id] !== status) agentStatus[id] = status
}

export function setAttention(id) {
  attention[id] = true
}

export function clearAttention(id) {
  if (attention[id]) delete attention[id]
}

export function clearAgentStatus(id) {
  delete agentStatus[id]
  delete attention[id]
  delete limits[id]
  delete approvals[id]
  delete monitoring[id]
  delete agentStates[id]
}

// Its own hooks show it took a message whose Enter was pressed at `at`
// (deliver.js): a turn they opened since (UserPromptSubmit: working; a
// question, AskUserQuestion: approval) or a turn that ended since (a short
// one, never seen busy on screen). Not for a message typed while it worked.
export function agentTookMessage(id, launchToken, at) {
  const state = getAgentState(id, launchToken)
  if (!state || !state.hookSeen || state.stale || state.confirmed === false || !Number.isFinite(at)) return false
  if (Number.isFinite(state.turnCompletedAt) && state.turnCompletedAt >= at) return true
  if (!Number.isFinite(state.since) || state.since < at) return false
  return state.state === 'approval' || (state.state === 'working' && state.source === 'hook')
}

// When this pane's agent ended its turn, by its own hooks (its published
// state is idle), or null while it works or nothing confirms it. Its
// unfinished sub-agents that wrote nothing since are not running
// (agentChildrenView.js childActive).
export function turnEndedSince(id, launchToken) {
  const state = getAgentState(id, launchToken)
  if (!state || !state.confirmed || state.stale || !state.hookSeen || state.state !== 'idle') return null
  return Number.isFinite(state.since) ? state.since : null
}

// A pane's agent state for the sidebar and the status bar: 'approval' (asks
// you to approve something) | 'limited' (usage limit reached) | 'working' |
// 'monitoring' (its turn ended, its background work still runs) |
// 'unknown' | 'waiting' (done, waiting for you) | 'ready'. childrenRunning:
// its sub-agents running now (the pane header counts them, running only).
export function paneAgentState(leaf, { agent = true, childrenRunning = 0 } = {}) {
  if (!agent) return 'ready'
  if (approvals[leaf.id]) return 'approval'
  if (limits[leaf.id]) return 'limited'
  // Its background sub-agents are part of that background work.
  if (paneMonitoring(leaf)) return 'monitoring'
  if (childrenRunning > 0) return 'working'
  if (managedAgentStatus(leaf) && agentStatus[leaf.id] === 'unknown') return 'unknown'
  // Working again (a new turn, one it started itself) wins over an earlier
  // finished turn you have not looked at yet.
  if (agentStatus[leaf.id] === 'busy') return 'working'
  if (attention[leaf.id]) return 'waiting'
  return 'ready'
}
