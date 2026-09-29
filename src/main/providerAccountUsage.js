// Local observations follow the chosen Codex home. No authenticated usage API.
import os from 'os'
import { join } from 'path'
import { createHash } from 'crypto'
import { getUsage, createUsageReader } from './agentUsage'
import { createCodexUsageReport } from './codexUsageReport'
import { t } from './i18n'

export function createAccountUsage({
  accounts,
  userData,
  home = os.homedir(),
  env = process.env,
  readUsage = getUsage,
  makeReport = createCodexUsageReport
}) {
  const readers = new Map()
  async function context() {
    const result = await accounts.usageEnv()
    if (!result?.ok) throw new Error(result?.error || t('main.accounts.codexUnavailable', 'The selected Codex account is unavailable.'))
    const selected = { ...env, ...result.env }
    const root = selected.CODEX_HOME || join(home, '.codex')
    const key = createHash('sha256').update(root).digest('hex').slice(0, 32)
    if (!readers.has(key)) {
      // Each account gets its own derived cache; switching cannot re-label
      // another account's quota or evict its incremental report on disk.
      if (readers.size >= 24) readers.delete(readers.keys().next().value)
      readers.set(key, {
        usage: createUsageReader({ read: () => readUsage({ home, env: selected }) }),
        report: makeReport({ home, env: selected, userData: join(userData, 'account-usage', key) })
      })
    }
    return { reader: readers.get(key), accountId: result.accountId || null }
  }
  return {
    async usage() {
      try {
        const { reader, accountId } = await context()
        const result = await reader.usage()
        const state = await accounts.list()
        const claude = state.providers.find((p) => p.provider === 'claude')
        return {
          agents: result.agents.map((agent) => {
            if (agent.id === 'codex') return { ...agent, accountId }
            // Legacy optional Claude snapshots carry no account identity. Do not
            // attach the prior system user's reading to a managed Claude login.
            if (agent.id === 'claude' && (claude?.selectedId || claude?.error))
              return {
                id: 'claude',
                accountId: claude.selectedId,
                windows: [],
                source: 'unavailable',
                observedAt: null,
                stale: false,
                error: t('main.usage.noClaudeObservation', 'No verified local quota observation for this Claude account.')
              }
            return agent
          })
        }
      } catch {
        return {
          agents: [
            {
              id: 'codex',
              windows: [],
              source: 'unavailable',
              observedAt: null,
              stale: false,
              error: t('main.usage.codexAccountUnreadable', 'The selected Codex account could not be read. Check AI provider accounts.')
            },
            { id: 'claude', windows: [], source: 'unavailable', observedAt: null, stale: false }
          ]
        }
      }
    },
    async report(query = {}) {
      const { reader, accountId } = await context()
      return { ...(await reader.report(query)), accountId }
    }
  }
}
