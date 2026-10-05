// Bind saved conversations to the home they came from. The renderer passes an
// account id only; managed paths are always resolved and checked in main.
import os from 'os'
import { join } from 'path'
import { claudeSessionExists, findCodexSession, listSessions } from './agentSessions'
import { findAgentSession } from './agentResume'
import { claudeSessionTitle, codexSessionTitle } from './sessionTitle'
import { claudeSubagents, codexSubagents, opencodeSubagents, clineSubagents } from './agentChildren'
import { clineDataDir } from './jsonAgents'
import { deleteSession, revealSessionFile, sessionDetails } from './sessionDetails'

// listSessions: the list reader (index.js gives one that reads in its own
// process, sessionListClient.js); by default agentSessions' own, here.
export function createAccountSessions({
  accounts,
  home = os.homedir(),
  env = process.env,
  listSessions: readList = async (...args) => listSessions(...args)
}) {
  const root = (provider, result) =>
    provider === 'codex'
      ? result.env?.CODEX_HOME || env.CODEX_HOME || join(home, '.codex')
      : result.env?.CLAUDE_CONFIG_DIR || env.CLAUDE_CONFIG_DIR || join(home, '.claude')
  async function find(q = {}) {
    if (q.agent !== 'codex') return findAgentSession(q, home)
    const scope = await accounts.sessionEnv('codex', q.accountId)
    return scope.ok ? findCodexSession(q, home, Date.now(), root('codex', scope)) : null
  }
  // The folders a conversation's transcript is in (sessionDetails.js): the
  // account's for Claude Code and Codex, or null when that account is gone.
  async function roots({ agent, accountId } = {}) {
    if (agent !== 'claude' && agent !== 'codex') return {}
    const scope = await accounts.sessionEnv(agent, accountId)
    return scope.ok ? { [agent]: root(agent, scope) } : null
  }
  return {
    find,
    roots,
    // One past conversation, for the Agent Session History panel: its
    // details, its file in the file manager, its deletion.
    async details(q = {}) {
      const r = await roots(q)
      return r ? sessionDetails(q, home, r) : { ok: false }
    },
    async reveal(q = {}, showItemInFolder) {
      const r = await roots(q)
      return r ? revealSessionFile(q, home, r, showItemInFolder) : { ok: false, error: 'missing' }
    },
    async remove(q = {}, trashItem) {
      const r = await roots(q)
      return r ? deleteSession(q, home, r, trashItem) : { ok: false, error: 'missing' }
    },
    // The sub-agents a Claude Code or Codex conversation started
    // (agentChildren.js), read in the home it came from (a Codex pane's
    // account CODEX_HOME).
    async children({ agent, sessionId, accountId } = {}) {
      // OpenCode and Cline: one shared data folder (no managed logins).
      if (agent === 'opencode') return opencodeSubagents(sessionId, env.XDG_DATA_HOME || join(home, '.local', 'share'))
      if (agent === 'cline') return clineSubagents(sessionId, clineDataDir(home))
      if (agent !== 'claude' && agent !== 'codex') return []
      const scope = await accounts.sessionEnv(agent, accountId)
      if (!scope.ok) return []
      return agent === 'claude'
        ? claudeSubagents(sessionId, root('claude', scope))
        : codexSubagents(sessionId, root('codex', scope))
    },
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
      const out = (
        await readList(query, home, {
          codex: null,
          claude: claude.ok ? root('claude', claude) : null
        })
      ).map((row) => (row.agent === 'claude' ? { ...row, accountId: claude.accountId ?? null } : row))
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
        const rows = await readList(query, home, {
          codex: root('codex', scope),
          claude: null,
          others: false
        })
        out.push(...rows.map((row) => ({ ...row, accountId, accountLabel: label })))
      }
      return out.sort((a, b) => b.updated - a.updated)
    }
  }
}
