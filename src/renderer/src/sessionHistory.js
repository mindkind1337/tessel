// The Agent Session History panel's logic (SessionHistoryPanel.vue): the
// view options and how they persist, how the listed conversations are
// filtered, sorted and grouped, the labels of counts and times, and what
// blocks Delete. After Orca's right-sidebar ai-vault-session-filters.ts,
// ai-vault-view-defaults.ts, ai-vault-session-limit.ts,
// ai-vault-view-options-persistence.ts, ai-vault-session-time.tsx and
// ai-vault-session-deletability.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
import { t } from './i18n'
import { maskSecrets } from './chat/chatModel'

export const AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'opencode', 'openclaude', 'copilot', 'kimi', 'cline', 'cursor', 'droid', 'grok', 'pi', 'omp', 'antigravity', 'devin', 'zcode']
export const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex',
  gemini: 'Gemini',
  qwen: 'Qwen',
  opencode: 'OpenCode',
  openclaude: 'OpenClaude',
  copilot: 'Copilot',
  kimi: 'Kimi',
  cline: 'Cline',
  cursor: 'Cursor',
  droid: 'Droid',
  grok: 'Grok',
  pi: 'Pi',
  omp: 'OMP',
  antigravity: 'Antigravity',
  devin: 'Devin',
  zcode: 'ZCode'
}
export const agentLabel = (agent) => AGENT_NAME[agent] || agent

// The agents whose transcript Tessel reads (a log, a first prompt, latest
// turns) and the ones it can delete: the same lists as src/main/sessionDetails.js
// (the main process checks again).
export const CONTENT_AGENTS = ['claude', 'openclaude', 'codex', 'grok', 'pi', 'omp']
export const DELETABLE_AGENTS = ['claude', 'openclaude', 'grok', 'pi', 'omp']
export const hasLog = (agent) => CONTENT_AGENTS.includes(agent)

// How many conversations per agent the list asks for (the main process
// caps at 200); Show more steps the same setting.
export const SESSION_LIMITS = [50, 100, 200]
export const SESSION_LIMIT_STEP = 50
export const MAX_SESSION_LIMIT = 200
export const DEFAULT_SESSION_LIMIT = 50
export const DEFAULT_SORT = 'updated'
export const DEFAULT_SEARCH_SORT = 'relevance'
export const DEFAULT_GROUP = 'folder'
export const GROUPS = ['folder', 'agent']
export const SORTS = ['updated', 'created']
export const SEARCH_SORTS = ['relevance', 'newest']
export const SCOPES = ['workspace', 'project', 'all']

export function normalizeSessionLimit(value) {
  return SESSION_LIMITS.includes(value) ? value : DEFAULT_SESSION_LIMIT
}

export function defaultViewOptions() {
  return { agents: [...AGENTS], sort: DEFAULT_SORT, searchSort: DEFAULT_SEARCH_SORT, group: DEFAULT_GROUP, limit: DEFAULT_SESSION_LIMIT }
}
// Whatever was saved, made valid: unknown agents dropped, unknown choices
// back to their default.
export function normalizeViewOptions(raw) {
  const d = defaultViewOptions()
  const o = raw && typeof raw === 'object' ? raw : {}
  return {
    agents: Array.isArray(o.agents) ? AGENTS.filter((a) => o.agents.includes(a)) : d.agents,
    sort: SORTS.includes(o.sort) ? o.sort : d.sort,
    searchSort: SEARCH_SORTS.includes(o.searchSort) ? o.searchSort : d.searchSort,
    group: GROUPS.includes(o.group) ? o.group : d.group,
    limit: normalizeSessionLimit(o.limit)
  }
}
// The sorts are not counted: the bar above the list shows them.
export function countViewAdjustments(o) {
  const allAgents = AGENTS.every((a) => o.agents.includes(a))
  return (allAgents ? 0 : 1) + (o.group === DEFAULT_GROUP ? 0 : 1) + (o.limit === DEFAULT_SESSION_LIMIT ? 0 : 1)
}

export const VIEW_STORAGE_KEY = 'tessel.sessionHistory.view'
export function loadViewOptions(storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    return normalizeViewOptions(JSON.parse(storage.getItem(VIEW_STORAGE_KEY)))
  } catch {
    return defaultViewOptions()
  }
}
export function saveViewOptions(o, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  try {
    storage.setItem(VIEW_STORAGE_KEY, JSON.stringify(normalizeViewOptions(o)))
  } catch {
    // no storage: the options last for this window
  }
}

// --- Folders ---------------------------------------------------------------------

// One spelling of a folder: forward slashes, no trailing slash, lower case
// (the agents copy cwd out of their own files, each its own way).
export function folderKey(p) {
  return String(p || '')
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}
// Is `cwd` the folder `root`, or inside it?
export function inFolder(cwd, root) {
  const c = folderKey(cwd)
  const r = folderKey(root)
  if (!c || !r) return false
  return c === r || c.startsWith(`${r}/`)
}
// The last two segments ("Tessel/src"), as Orca labels a session's folder.
export function folderLabel(p) {
  if (!p) return t('sessionHistory.unknownLocation', 'Unknown location')
  const parts = String(p)
    .replace(/\\/g, '/')
    .split('/')
    .filter(Boolean)
  if (parts.length >= 2) return parts.slice(-2).join('/')
  return parts[0] || String(p)
}

// --- The list --------------------------------------------------------------------

const sortTime = (s, sort) => (sort === 'created' ? s.started || s.updated || 0 : s.updated || 0)

// The conversations shown while browsing: those of the chosen agents, in
// the scope (workspace: this folder; project: this folder and below), whose
// title, id, agent or folder holds every word typed; newest first.
export function filterSessions(sessions, { query = '', agents = AGENTS, scope = 'all', sort = DEFAULT_SORT, cwd = null } = {}) {
  const terms = String(query).toLowerCase().split(/\s+/).filter(Boolean)
  const wanted = new Set(agents)
  const out = (sessions || []).filter((s) => {
    if (!wanted.has(s.agent)) return false
    if (scope === 'workspace' && !(cwd && folderKey(s.cwd) === folderKey(cwd))) return false
    if (scope === 'project' && !(cwd && inFolder(s.cwd, cwd))) return false
    if (terms.length) {
      const text = `${s.title || ''} ${s.id || ''} ${s.agent || ''} ${agentLabel(s.agent)} ${s.cwd || ''}`.toLowerCase()
      if (terms.some((w) => !text.includes(w))) return false
    }
    return true
  })
  return out.sort((a, b) => sortTime(b, sort) - sortTime(a, sort))
}

// -> [{ key, label, sessions }], in the order the sessions come.
export function groupSessions(sessions, group) {
  const groups = new Map()
  for (const s of sessions || []) {
    const key = group === 'agent' ? `agent:${s.agent}` : s.cwd ? `folder:${folderKey(s.cwd)}` : 'unknown' // i18n-ignore
    const label = group === 'agent' ? agentLabel(s.agent) : folderLabel(s.cwd)
    const g = groups.get(key)
    if (g) g.sessions.push(s)
    else groups.set(key, { key, label, sessions: [s] })
  }
  return [...groups.values()]
}

// Show more: once some agent filled the depth asked for, and more is allowed.
export function showMoreAvailable(sessions, limit) {
  if (limit >= MAX_SESSION_LIMIT || !sessions || !sessions.length) return false
  const counts = {}
  for (const s of sessions) counts[s.agent] = (counts[s.agent] || 0) + 1
  return Object.values(counts).some((n) => n >= limit)
}

// The bar above the list: how many are shown, and how many the filters hid.
export function sessionCountLabel(shown, loaded) {
  if (shown !== loaded) return t('sessionHistory.bar.sessionsOfLoaded', '{{shown}} of {{loaded}} sessions', { shown, loaded })
  return shown === 1
    ? t('sessionHistory.bar.sessions', '{{count}} session', { count: shown })
    : t('sessionHistory.bar.sessions', '{{count}} sessions', { count: shown })
}
export function resultCountLabel(count) {
  return count === 1 ? t('sessionHistory.bar.results', '{{count}} result', { count }) : t('sessionHistory.bar.results', '{{count}} results', { count })
}

// "Just now", "5m ago", "3h ago", "2d ago", "4mo ago", "1y ago".
export function timeAgo(ms, now = Date.now()) {
  if (!Number.isFinite(ms) || ms <= 0) return t('sessionHistory.time.unknown', 'Unknown time')
  const diff = Math.max(0, now - ms)
  if (diff < 60_000) return t('sessionHistory.time.justNow', 'Just now')
  const minutes = Math.floor(diff / 60_000)
  if (minutes < 60) return t('sessionHistory.time.minutes', '{{n}}m ago', { n: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('sessionHistory.time.hours', '{{n}}h ago', { n: hours })
  const days = Math.floor(hours / 24)
  if (days < 30) return t('sessionHistory.time.days', '{{n}}d ago', { n: days })
  const months = Math.floor(days / 30)
  if (months < 12) return t('sessionHistory.time.months', '{{n}}mo ago', { n: months })
  return t('sessionHistory.time.years', '{{n}}y ago', { n: Math.floor(months / 12) })
}

// Why Delete is not offered for this conversation (the tooltip), or null.
export function deleteBlockedReason(session, openIds = {}) {
  if (!session) return null
  if (openIds[session.id]) return t('sessionHistory.row.deleteReasonOpen', 'This session is open in a pane. Close it first.')
  if (!DELETABLE_AGENTS.includes(session.agent))
    return t('sessionHistory.row.deleteReasonUnsupportedAgent', "{{agent}} sessions can't be deleted from Tessel.", { agent: agentLabel(session.agent) })
  return null
}

// --- Search results ----------------------------------------------------------------

// A search hit (src/main/sessionSearch) as a row of the list.
export function hitRow(h) {
  return {
    agent: h.agent,
    id: h.sessionId,
    cwd: h.cwd || '',
    title: maskSecrets(h.title || '') || t('app.sessions.untitled', 'Untitled conversation'),
    updated: h.updatedAt || 0,
    messageCount: Number.isFinite(h.messageCount) ? h.messageCount : null,
    // The passage, its matches marked: [{ text, match }], and who said it.
    evidence: h.evidence && h.evidence.snippet ? { role: h.evidence.role || 'user', parts: snippetParts(h.evidence.snippet) } : null
  }
}
// The index marks a match with private-use characters (never in a
// conversation's text: the index takes them out). Its text already has its
// secrets masked; masked once more here, on each part, so a mark cannot
// split one.
export const MARK_OPEN = ''
export const MARK_CLOSE = ''
export function snippetParts(snippet) {
  const out = []
  String(snippet)
    .split(MARK_OPEN)
    .forEach((piece, i) => {
      const end = piece.indexOf(MARK_CLOSE)
      if (i === 0 || end < 0) {
        if (piece) out.push({ text: maskSecrets(piece.replace(MARK_CLOSE, '')), match: false })
        return
      }
      out.push({ text: maskSecrets(piece.slice(0, end)), match: true })
      if (piece.length > end + 1) out.push({ text: maskSecrets(piece.slice(end + 1)), match: false })
    })
  return out
}

export function roleLabel(role) {
  if (role === 'user') return t('sessionHistory.role.user', 'You')
  if (role === 'assistant') return t('sessionHistory.role.agent', 'Agent')
  if (role === 'tool') return t('sessionHistory.role.tool', 'Tool')
  if (role === 'system') return t('sessionHistory.role.system', 'System')
  return t('sessionHistory.role.session', 'Session')
}
