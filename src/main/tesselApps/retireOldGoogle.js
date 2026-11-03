import fs from 'node:fs'
import { dirname } from 'node:path'

// Google connected through Tessel replaces the community server the old Google row set up, so an
// agent does not have two Gmails. Only that name, only for an agent that has Tessel's tools (it
// would be left with no Gmail at all), and once for each agent: the ones done are kept in `file`,
// so a server added back from the MCP dialog stays, until Google is connected again. It also runs
// at a start: Google may have been connected before this existed, or a removal may have failed.
// Running agents keep the server until they are restarted.
export const OLD_GOOGLE_SERVER = 'google-workspace'

export function createRetireOldGoogle({ file, replacement, connected, agentsWith, remove }) {
  let wasConnected = null
  let running = false
  // Refused once in this run: asked again at the next start, not at every change of a connection.
  const refused = new Set()

  function agentsDone() {
    try {
      const done = JSON.parse(fs.readFileSync(file, 'utf8'))
      return Array.isArray(done) ? done : []
    } catch {
      return []
    }
  }
  function remember(agents) {
    fs.mkdirSync(dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify(agents))
  }

  // -> { removed: [agent], failed: [{ agent, error }] }
  async function check() {
    const outcome = { removed: [], failed: [] }
    if (running) return outcome
    const isConnected = connected()
    const justConnected = isConnected && wasConnected === false
    wasConnected = isConnected
    if (!isConnected) return outcome
    running = true
    try {
      if (justConnected) refused.clear()
      const done = new Set(justConnected ? [] : agentsDone())
      const before = done.size
      const holding = new Set(agentsWith(OLD_GOOGLE_SERVER))
      for (const agent of agentsWith(replacement)) {
        if (done.has(agent) || refused.has(agent)) continue
        if (holding.has(agent)) {
          const result = await Promise.resolve()
            .then(() => remove(agent, OLD_GOOGLE_SERVER))
            .catch((err) => ({ ok: false, error: err && err.message }))
          if (!result || !result.ok) {
            refused.add(agent)
            outcome.failed.push({ agent, error: (result && result.error) || 'not removed' }) // i18n-ignore log
            continue
          }
          outcome.removed.push(agent)
        }
        done.add(agent)
      }
      if (justConnected || done.size !== before) remember([...done])
    } finally {
      running = false
    }
    return outcome
  }

  return { check }
}
