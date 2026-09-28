// Provider capabilities, independent of installation or a successful login.
// Quotas are not token/cost history; only a report collector enables Stats.
export const USAGE_PROVIDERS = Object.freeze([
  { id: 'claude', name: 'Claude Code', agents: ['claude'], report: true },
  { id: 'codex', name: 'Codex', agents: ['codex'], report: true },
  { id: 'gemini', name: 'Gemini', agents: ['gemini'], report: false },
  { id: 'kimi', name: 'Kimi', agents: ['kimi'], report: false },
  { id: 'cursor', name: 'Cursor', agents: ['cursor'], report: false },
  { id: 'grok', name: 'Grok', agents: ['grok'], report: false },
  { id: 'opencode-go', name: 'OpenCode Go', agents: ['opencode'], report: false },
  { id: 'minimax', name: 'MiniMax', agents: ['opencode', 'claude'], report: false }
])
export function installedUsageProviders(agents = []) {
  const ids = new Set(agents.filter((a) => a?.available).map((a) => a.id))
  return USAGE_PROVIDERS.filter((p) => p.agents.some((id) => ids.has(id)))
}
export function validHiddenUsageProviders(value) {
  return Array.isArray(value)
    ? [...new Set(value.filter((id) => USAGE_PROVIDERS.some((p) => p.id === id)))]
    : []
}
