// Bind saved conversations to the home they came from. The renderer passes an
// account id only; managed paths are always resolved and checked in main.
import os from 'os'
import { join } from 'path'
import { claudeSessionExists, findCodexSession, listSessions } from './agentSessions'
import { findAgentSession } from './agentResume'
import { claudeSessionTitle, codexSessionTitle } from './sessionTitle'

export function createAccountSessions({ accounts, home = os.homedir(), env = process.env }) {
  const root = (provider, result) =>
    provider === 'codex'
      ? result.env?.CODEX_HOME || env.CODEX_HOME || join(home, '.codex')
      : result.env?.CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  async function find(q = {}) {
    if (q.agent !== 'codex') return findAgentSession(q, home)
    const scope = await accounts.sessionEnv('codex', q.accountId)
    return scope.ok ? findCodexSession(q, home, Date.now(), root('codex', scope)) : null
  }
  return {
    find,
    // The conversation's own title, read in the home it came from.
    async title({ agent, sessionId, accountId } = {}) {
      if (agent !== 'claude' && agent !== 'codex') return ''
      const scope = await accounts.sessionEnv(agent, accountId)
      if (!scope.ok) return ''
      return agent === 'claude'
        ? claudeSessionTitle(sessionId, root('claude', scope))
        : codexSessionTitle(sessionId, root('codex', scope))
    },
    async claudeExists(id, { accountId } = {}) {
      const scope = await accounts.sessionEnv('claude', accountId)
      return scope.ok ? claudeSessionExists(id, home, root('claude', scope)) : false
    },
    async list(query = {}) {
      const all = await accounts.list()
      // Non-Codex histories are shared by the provider, not per managed login.
      const claude = await accounts.sessionEnv('claude')
      const out = listSessions(query, home, {
        codex: null,
        claude: claude.ok ? root('claude', claude) : null
      }).map((row) =>
        row.agent === 'claude' ? { ...row, accountId: claude.accountId ?? null } : row
      )
      const provider = all.providers.find((entry) => entry.provider === 'codex')
      if (provider?.error) return out
      const ids = [null, ...(provider?.accounts || []).map((account) => account.id)]
      for (const accountId of ids) {
        const scope = await accounts.sessionEnv('codex', accountId)
        if (!scope.ok) continue
        const label =
          accountId === null
            ? 'System default'
            : provider.accounts.find((account) => account.id === accountId)?.label ||
              'Codex account'
        out.push(
          ...listSessions(query, home, {
            codex: root('codex', scope),
            claude: null,
            others: false
          }).map((row) => ({ ...row, accountId, accountLabel: label }))
        )
      }
      return out.sort((a, b) => b.updated - a.updated)
    }
  }
}
