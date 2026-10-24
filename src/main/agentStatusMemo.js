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

export function statusMemoKey(provider, env, optIn) {
  const variable = provider === 'codex' ? 'CODEX_HOME' : provider === 'claude' ? 'CLAUDE_CONFIG_DIR' : null
  const root = variable ? Object.entries(env || {}).find(([key]) => key.toUpperCase() === variable)?.[1] || '' : ''
  return `${provider}|${root}|${optIn && optIn.cursor ? 1 : 0}`
}

// run(provider, env, optIn) -> Promise<result>
export function createStatusMemo({ run, now = Date.now, ttlMs = STATUS_MEMO_MS }) {
  const memo = new Map() // key -> { at, result }
  return async function prepare(provider, env, optIn) {
    const key = statusMemoKey(provider, env, optIn)
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
