// Tessel's agents, read from the main process's own source (src/main/index.js, its
// AGENT_PRESETS). That file needs Electron and cannot be imported in a browser build,
// so its list is read as text, as src/main/__tests__/agentInstalls.spec.js does.
// The agents the demo pretends are installed get available: true.
const AVAILABLE = ['claude', 'codex', 'gemini', 'opencode']

export function agentPresetsFrom(source) {
  const start = source.indexOf('const AGENT_PRESETS = [')
  const end = source.indexOf('async function getAgents(')
  const text = start >= 0 && end > start ? source.slice(start, end) : ''
  const comment = '(?:\\/\\/[^\\n]*\\n\\s*)*'
  const field = (name) => `${comment}${name}: '([^']+)',\\s*`
  const entry = new RegExp(`\\{\\s*${field('id')}${field('name')}${field('command')}${comment}accent: '([^']+)'`, 'g')
  const list = []
  for (const m of text.matchAll(entry)) {
    list.push({ id: m[1], name: m[2], command: m[3], accent: m[4], install: null, available: AVAILABLE.includes(m[1]) })
  }
  // Never an empty launcher, even if that source changes its shape.
  if (!AVAILABLE.every((id) => list.some((a) => a.id === id))) {
    return [
      { id: 'claude', name: 'Claude Code', command: 'claude', accent: '#d97757', install: null, available: true },
      { id: 'codex', name: 'Codex CLI', command: 'codex', accent: '#10a37f', install: null, available: true },
      { id: 'gemini', name: 'Gemini CLI', command: 'gemini', accent: '#4285f4', install: null, available: true },
      { id: 'opencode', name: 'OpenCode', command: 'opencode', accent: '#e8e8e8', install: null, available: true }
    ]
  }
  return list
}
