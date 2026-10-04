// Changing a running Claude Code's model with /model, after Orca's
// claude-model-switch-confirmation.ts (github.com/stablyai/orca, MIT,
// Copyright (c) 2026 Lovecast Inc.): Tessel types "/model <id>", watches
// what Claude prints, and
// - "Switch model? … This conversation is cached for the current model":
//   the pick already said yes, so Enter accepts it (Claude's own default);
// - "Set model to <name>": applied;
// - "Kept model as …": rejected;
// - nothing of that within 5 s: unknown (the user checks the terminal).

const DETECTION_TIMEOUT_MS = 5_000
const MAX_OBSERVED = 64 * 1024
const SUBMIT = '\r'

const ESC = String.fromCharCode(27)
const ANSI_ESCAPE = new RegExp(`${ESC}\\[[0-?]*[ -/]*[@-~]`, 'g')
const OSC_SEQUENCE = new RegExp(`${ESC}\\][^\\u0007]*(?:\\u0007|${ESC}\\\\)`, 'g')
const SINGLE_ESCAPE = new RegExp(`${ESC}(?:[@-Z\\\\-_]|[()*+\\-./][0-~]|c)`, 'g')

export function stripAnsi(value) {
  return String(value || '')
    .replace(OSC_SEQUENCE, '')
    .replace(ANSI_ESCAPE, '')
    .replace(SINGLE_ESCAPE, '')
}

// Why (Orca): Claude positions TUI words with cursor-column escapes instead
// of literal spaces, so matching must not depend on rendered gaps.
function compact(buffer) {
  return stripAnsi(buffer).replace(/\s+/g, '').toLowerCase()
}

export function hasClaudeModelSwitchConfirmation(buffer) {
  const text = compact(buffer)
  return text.includes('switchmodel?') && text.includes('thisconversationiscachedforthecurrentmodel')
}

export function hasClaudeModelSwitchSuccess(buffer, modelLabel) {
  const text = compact(buffer)
  if (text.includes(`setmodelto${String(modelLabel).replace(/\s+/g, '').toLowerCase()}`)) return true // i18n-ignore
  // Why (Orca): resolved echoes insert a version ("Opus 5 (1M context)");
  // every picker token must appear, in order.
  const labelTokens = String(modelLabel).toLowerCase().match(/[a-z]+|\d+[a-z]*/g) || []
  const successStart = text.lastIndexOf('setmodelto')
  if (successStart === -1 || labelTokens.length === 0) return false
  const successText = text.slice(successStart)
  let tokenEnd = 0
  for (const token of labelTokens) {
    const tokenStart = successText.indexOf(token, tokenEnd)
    if (tokenStart === -1) return false
    tokenEnd = tokenStart + token.length
  }
  return true
}

export function hasClaudeModelSwitchRejection(buffer) {
  return compact(buffer).includes('keptmodelas')
}

// subscribe(watcher) -> unsubscribe; submit() writes Enter.
// -> { result: Promise<'applied'|'rejected'|'unknown'>, arm(), startDetection(), dispose() }
export function createClaudeModelSwitchObserver({ expectedModelLabel, subscribe, submit, timeoutMs = DETECTION_TIMEOUT_MS }) {
  let armed = false
  let settled = false
  let confirmationSubmitted = false
  let observed = ''
  let timeout = null
  let unsubscribe = null
  let resolveResult
  const result = new Promise((resolve) => {
    resolveResult = resolve
  })
  const finish = (outcome) => {
    if (settled) return
    settled = true
    if (timeout !== null) clearTimeout(timeout)
    timeout = null
    if (unsubscribe) unsubscribe()
    unsubscribe = null
    resolveResult(outcome)
  }
  const scheduleTimeout = () => {
    if (timeout !== null) clearTimeout(timeout)
    timeout = setTimeout(() => finish('unknown'), timeoutMs)
  }
  const observe = (data) => {
    if (!armed || settled) return
    observed = `${observed}${data}`.slice(-MAX_OBSERVED)
    if (expectedModelLabel && hasClaudeModelSwitchSuccess(observed, expectedModelLabel)) return finish('applied')
    if (hasClaudeModelSwitchRejection(observed)) return finish('rejected')
    if (!confirmationSubmitted && hasClaudeModelSwitchConfirmation(observed)) {
      confirmationSubmitted = true
      try {
        // Why (Orca): the picker selection already expresses consent to
        // switch; this exact Claude warning defaults to "Yes".
        if (submit() === false) return finish('unknown')
        scheduleTimeout()
      } catch {
        finish('unknown')
      }
    }
  }
  try {
    unsubscribe = subscribe(observe)
  } catch {
    finish('unknown')
  }
  return {
    result,
    arm() {
      if (!settled) armed = true
    },
    // Why (Orca): the window is measured from when the command is delivered.
    startDetection() {
      if (!settled) scheduleTimeout()
    },
    dispose() {
      finish('unknown')
    }
  }
}

// A pane's output, for the observer.
export function subscribePaneOutput(paneId, watcher) {
  if (!window.shellApi || !window.shellApi.onData) throw new Error('no terminal output') // i18n-ignore
  return window.shellApi.onData(({ id, data }) => {
    if (id === paneId) watcher(data)
  })
}

// Types a slash command into a pane and presses Enter separately (Orca's
// body-then-Enter, so the agent never takes it as pasted text). 'type':
// one character at a time (Codex takes a multi-character write as a paste).
export async function typeCommand(paneId, command, { delivery = 'write', gapMs = 120 } = {}) {
  const write = (data) => window.shellApi.writePty(paneId, data)
  if (delivery === 'type') {
    for (const ch of command) {
      write(ch)
      await new Promise((r) => setTimeout(r, 15))
    }
  } else write(command)
  await new Promise((r) => setTimeout(r, gapMs))
  write(SUBMIT)
}

// /model <id> in a running Claude Code, confirmed. -> 'applied' | 'rejected' | 'unknown'
export async function switchClaudeModel(paneId, modelId, expectedModelLabel) {
  const observer = createClaudeModelSwitchObserver({
    expectedModelLabel,
    subscribe: (w) => subscribePaneOutput(paneId, w),
    submit: () => {
      window.shellApi.writePty(paneId, SUBMIT)
      return true
    }
  })
  observer.arm()
  // Claude Code saves a /model pick as its default for new sessions: this one
  // is for this pane only.
  if (window.shellApi.claudeHoldDefaultModel) await window.shellApi.claudeHoldDefaultModel().catch(() => {})
  try {
    await typeCommand(paneId, `/model ${modelId}`) // i18n-ignore
  } catch {
    observer.dispose()
  }
  observer.startDetection()
  return observer.result
}
