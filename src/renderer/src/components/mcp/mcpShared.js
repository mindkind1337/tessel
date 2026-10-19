// What the parts of Settings > MCP servers share (McpDialog.vue and the
// components here): the agents, their names, and how a test result or a
// server's command reads.
import { t, intlLocale } from '../../i18n'
import { openTarget } from '../../links/openTarget'

export const ALL_AGENTS = ['claude', 'codex', 'gemini', 'qwen', 'copilot', 'opencode', 'cline', 'kimi', 'cursor', 'antigravity', 'muse']
export const AGENT_NAME = {
  claude: 'Claude Code', // i18n-ignore
  codex: 'Codex', // i18n-ignore
  gemini: 'Gemini CLI', // i18n-ignore
  qwen: 'Qwen Code', // i18n-ignore
  copilot: 'Copilot CLI', // i18n-ignore
  opencode: 'OpenCode', // i18n-ignore
  cline: 'Cline', // i18n-ignore
  kimi: 'Kimi Code', // i18n-ignore
  cursor: 'Cursor CLI', // i18n-ignore
  antigravity: 'Antigravity CLI', // i18n-ignore
  muse: 'Muse Code' // i18n-ignore
}

// The agents that connect to streamable HTTP servers only (no SSE).
export const NO_SSE = ['codex', 'antigravity', 'muse']

// A server name the agents' commands accept (checked again when added).
export const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,64}$/

export function scopeLabel(scope) {
  if (scope === 'user') return t('mcp.scope.user', 'All projects')
  if (scope === 'local') return t('mcp.scope.local', 'This project (private)')
  if (scope === 'project') return t('mcp.scope.project', 'This project (shared)')
  return scope
}

// "Claude Code and Codex" in the interface's language.
export function agentList(names) {
  try {
    return new Intl.ListFormat(intlLocale(), { type: 'conjunction' }).format(names)
  } catch {
    return names.join(', ')
  }
}

// A test result as one word for its tag and dot: ok, auth, error, testing.
export function testState(res) {
  if (!res) return null
  if (res.status === 'testing') return 'testing'
  if (res.status === 'connected') return 'ok'
  if (res.status === 'auth') return 'auth'
  return 'error'
}

export function testLabel(res) {
  const state = testState(res)
  if (!state) return ''
  if (state === 'testing') return t('mcp.test.testing', 'Testing…')
  if (state === 'ok') {
    const count = res.tools ? res.tools.length : 0
    return count === 1
      ? t('mcp.test.connected', 'Connected · {{count}} tool', { count })
      : t('mcp.test.connected', 'Connected · {{count}} tools', { count })
  }
  if (state === 'auth') return t('mcp.test.needsSignIn', 'Needs sign-in')
  return t('mcp.test.failed', 'Failed')
}

// The whole answer, for a title or a Details disclosure.
export function testTitle(res) {
  if (!res) return ''
  if (res.status === 'connected') {
    const secs = (Math.round((res.ms || 0) / 100) / 10).toLocaleString(intlLocale())
    return t('mcp.test.answered', '{{server}} answered in {{secs}}s.\nTools: {{tools}}', {
      server: res.server || t('mcp.test.server', 'Server'),
      secs,
      tools: (res.tools || []).join(', ') || t('mcp.test.none', 'none')
    })
  }
  return [res.error, res.log].filter(Boolean).join('\n')
}

// A command with long paths, shortened for one line: a path keeps its root
// and its last two parts ("C:\…\resources\team-mcp.cjs"); the whole command
// stays in the title and what Copy copies.
export function shortTarget(target) {
  return String(target || '')
    .split(' ')
    .map((word) => {
      const quote = /^"/.test(word) ? '"' : ''
      const bare = word.replace(/^"|"$/g, '')
      const sep = bare.includes('\\') ? '\\' : '/'
      if (/^[a-z]+:\/\//i.test(bare)) return word // a URL stays whole
      const parts = bare.split(sep)
      if (parts.length <= 4) return word
      return quote + [parts[0], '…', ...parts.slice(-2)].join(sep) + quote
    })
    .join(' ')
}

export async function copyText(text) {
  try {
    if (window.shellApi && window.shellApi.writeClipboard) await window.shellApi.writeClipboard(text)
    else await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}

// A server's docs: Tessel's link router (links/openTarget.js), like every link.
export function openLink(url, event) {
  return openTarget(url, { event })
}

// Arrow keys, Home and End across a row of tabs (role="tab").
export function tabKeys(event, list, current, set) {
  const keys = { ArrowRight: 1, ArrowLeft: -1 }
  let i = list.indexOf(current)
  if (event.key in keys) i = (i + keys[event.key] + list.length) % list.length
  else if (event.key === 'Home') i = 0
  else if (event.key === 'End') i = list.length - 1
  else return
  event.preventDefault()
  set(list[i])
  const bar = event.currentTarget
  setTimeout(() => bar && bar.querySelector('[aria-selected="true"]')?.focus())
}
