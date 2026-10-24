// Agent status hooks prepared twice a moment apart.
//
// A new agent pane prepares its hooks twice: the window asks
// (agents:prepareStatus, before the account is chosen) and pty:create does it
// again with the pane's own variables. Each is 40-80 ms of synchronous file
// work in the main process (the shared script read, settings.json parsed), so
// a second one for the same agent and the same configuration folder within
// `ttlMs` is answered from the first. A failure is never kept (it retries), and
// a kept answer says nothing changed (the first one told the window).
export const STATUS_MEMO_MS = 15_000

// Only the agents whose installer target is fully known from one variable:
// the others (Grok, Kimi, Pi, Muse, dsh...) pick their files from several
// variables of the pane, so they are prepared every time (null: not kept).
// The node the hooks run (found on the pane's PATH) is part of the key.
export const MEMO_VARIABLES = { claude: 'CLAUDE_CONFIG_DIR', codex: 'CODEX_HOME' }
export function statusMemoKey(provider, env, optIn, nodeOf = () => '') {
  const variable = MEMO_VARIABLES[provider]
  if (!variable) return null
  const root = Object.entries(env || {}).find(([key]) => key.toUpperCase() === variable)?.[1] || ''
  return `${provider}|${root}|${optIn && optIn.cursor ? 1 : 0}|${nodeOf(env) || ''}`
}

// run(provider, env, optIn) -> Promise<result>
export function createStatusMemo({ run, now = Date.now, ttlMs = STATUS_MEMO_MS, nodeOf = () => '' }) {
  const memo = new Map() // key -> { at, result }
  return async function prepare(provider, env, optIn) {
    const key = statusMemoKey(provider, env, optIn, nodeOf)
    if (key === null) return run(provider, env, optIn)
    const hit = memo.get(key)
    if (hit && now() - hit.at < ttlMs) return { ...hit.result, changed: false, needsReview: false }
    const result = await run(provider, env, optIn)
    if (result && result.ok && result.supported) {
      if (memo.size > 50) memo.clear()
      memo.set(key, { at: now(), result })
    }
    return result
  }
}
