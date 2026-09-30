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
  const approval = detectApproval(screen)
  const limit = detectLimit(screen)
  const footer = String(screen || '')
    .split(/\r?\n/)
    .slice(-8)
    .join('\n')
  const busy =
    FOOTER.test(footer) || (!!term && provider === 'claude' && FOOTER.test(aboveCursor(term)))
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
    .join('\n')
  const interrupted =
    waiting &&
    ((provider === 'claude' && /\bInterrupted\b\s*(?:by user|·\s*What should Claude do instead)/i.test(above)) ||
      (provider === 'codex' && /\bConversation interrupted\b/i.test(above)))
  return { screen, approval, limit, busy, ready, waiting, interrupted }
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
        send(observation.interrupted ? 'ScreenInterrupted' : 'ScreenReady')
      } else if (observation.busy) {
        // Working again ("esc to interrupt", never an approval's "esc to
        // cancel") with no approval on screen: the approval was answered.
        const hadApproval =
          approvals[node.id] || getAgentState(node.id, node.agentLaunchToken)?.state === 'approval'
        const running = /\besc(?:ape)?\s+(?:to\s+)?interrupt\b/i.test(String(observation.screen || '').split(/\r?\n/).slice(-8).join('\n'))
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
  if (attention[leaf.id]) return 'waiting'
  return agentStatus[leaf.id] === 'busy' ? 'working' : 'ready'
}
