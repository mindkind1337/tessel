// What Tessel itself needs to work, and whether this machine has it (Tools >
// Tessel needs). Pure: the main process gathers the facts (index.js
// 'tools:needs'), this turns them into rows the user can act on.
//   status: 'ok' | 'warn' (works, but something to fix) | 'missing' (a
//   feature does not work) | 'optional' (only for some extras)
//   fix: { install: <Tools catalog id> } | { where: <where to go in Tessel> }

// Node.js runs the team tools and every agent's hooks (node "<script>" --hook).
export const MIN_NODE = 18
// Claude Code's own inbox (reminders never typed) needs this on Windows.
export const MIN_CLAUDE_INBOX = '2.1.234'

// "v22.19.0", "2.1.283 (Claude Code)" -> [22, 19, 0]; null when unreadable.
export function parseVersion(text) {
  const m = /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(String(text || ''))
  return m ? [Number(m[1]), Number(m[2] || 0), Number(m[3] || 0)] : null
}
export function versionAtLeast(text, min) {
  const v = parseVersion(text)
  const w = parseVersion(min)
  if (!v || !w) return false
  for (let i = 0; i < 3; i++) if (v[i] !== w[i]) return v[i] > w[i]
  return true
}

const NAMES = { claude: 'Claude Code', codex: 'Codex', gemini: 'Gemini CLI', copilot: 'Copilot CLI' }

// facts: { node: { path, version } | null, git: { path, configured } | null,
//   uvx: bool, agents: [{ id, name, available, custom }], claudeVersion,
//   script: { exists, version } | null, hooks: { agents: [...] } | { error } }
export function assessNeeds(facts = {}) {
  const rows = []
  const add = (row) => rows.push(row)

  // Node.js: without it no team message, board card or hook works.
  const node = facts.node
  if (!node || !node.path)
    add({
      id: 'node',
      name: 'Node.js',
      why: 'Runs the team tools and the agents’ hooks: team messages and the task board.',
      status: 'missing',
      detail: 'Not found on PATH.',
      fix: { install: 'node' }
    })
  else
    add({
      id: 'node',
      name: 'Node.js',
      why: 'Runs the team tools and the agents’ hooks: team messages and the task board.',
      status: versionAtLeast(node.version, String(MIN_NODE)) ? 'ok' : 'warn',
      detail: versionAtLeast(node.version, String(MIN_NODE))
        ? String(node.version || '').trim()
        : `${String(node.version || 'Unknown version').trim()}: version ${MIN_NODE} or newer is needed.`,
      fix: versionAtLeast(node.version, String(MIN_NODE)) ? null : { install: 'node' }
    })

  // At least one agent.
  const agents = (facts.agents || []).filter((a) => a && a.available && !a.custom)
  add({
    id: 'agents',
    name: 'An AI agent',
    why: 'Tessel runs agents such as Claude Code or Codex in its panes.',
    status: agents.length ? 'ok' : 'missing',
    detail: agents.length ? agents.map((a) => a.name || a.id).join(', ') : 'None installed.',
    fix: agents.length ? null : { where: 'Tools > AI agents' }
  })

  // The team tools script (MCP server + hooks), set up by Tessel itself.
  const script = facts.script
  add({
    id: 'team-tools',
    name: 'Team tools',
    why: 'Lets agents send each other messages and put their work on the board.',
    status: script && script.exists ? 'ok' : 'missing',
    detail: script && script.exists ? `Version ${script.version || 'unknown'}` : 'Not set up yet.',
    fix: script && script.exists ? null : { where: 'MCP servers > Team connections > Set up again' }
  })

  // Hooks of the installed agents that have them.
  const installed = new Set(agents.map((a) => a.id))
  const hookRows = (facts.hooks && Array.isArray(facts.hooks.agents) ? facts.hooks.agents : []).filter((r) => installed.has(r.id))
  if (facts.hooks && facts.hooks.error)
    add({ id: 'hooks', name: 'Agent hooks', why: 'Deliver team messages without typing into terminals.', status: 'warn', detail: 'Could not be checked.', fix: { where: 'MCP servers > Team connections' } })
  else if (hookRows.length) {
    const notSet = hookRows.filter((r) => r.hooks !== 'installed').map((r) => NAMES[r.id] || r.id)
    const codex = hookRows.find((r) => r.id === 'codex')
    const approve = codex && codex.hooks === 'installed' && codex.approval !== 'approved'
    const problems = []
    if (notSet.length) problems.push(`not set up for ${notSet.join(', ')}`)
    if (approve) problems.push('Codex: approve them once with /hooks')
    add({
      id: 'hooks',
      name: 'Agent hooks',
      why: 'Deliver team messages without typing into terminals.',
      status: problems.length ? 'warn' : 'ok',
      detail: problems.length ? problems.join('; ') + '.' : hookRows.map((r) => NAMES[r.id] || r.id).join(', '),
      fix: problems.length ? { where: 'MCP servers > Team connections' } : null
    })
  }

  // Claude Code's own inbox: reminders go there instead of being typed.
  if (installed.has('claude')) {
    const ok = versionAtLeast(facts.claudeVersion, MIN_CLAUDE_INBOX)
    add({
      id: 'claude-inbox',
      name: 'Claude Code inbox',
      why: 'Team reminders reach Claude Code without typing into its terminal.',
      status: ok ? 'ok' : 'warn',
      detail: ok
        ? `Claude Code ${parseVersion(facts.claudeVersion).join('.')}`
        : `${facts.claudeVersion ? `Claude Code ${String(facts.claudeVersion).trim()}` : 'Version unknown'}: ${MIN_CLAUDE_INBOX} or newer is needed (run "claude update"). Reminders are typed meanwhile.`,
      fix: ok ? null : { run: 'claude update' }
    })
  }

  // Git: agent copies (worktrees), changes and review.
  const git = facts.git
  add({
    id: 'git',
    name: 'Git',
    why: 'Separate copies for agents, the changes view and code review.',
    status: !git || !git.path ? 'warn' : git.configured ? 'ok' : 'warn',
    detail: !git || !git.path ? 'Not installed: those features are off.' : git.configured ? 'Installed, name and email set.' : 'Installed, but no name and email for commits.',
    fix: !git || !git.path ? { install: 'git' } : git.configured ? null : { where: 'Tools > Developer tools > Git > Set name & email' }
  })

  // uvx: only for Python MCP servers.
  add({
    id: 'uvx',
    name: 'uv (uvx)',
    why: 'Only for Python MCP servers such as Git, Fetch, Time or ElevenLabs.',
    status: facts.uvx ? 'ok' : 'optional',
    detail: facts.uvx ? 'Installed.' : 'Not installed: those MCP servers cannot start.',
    fix: facts.uvx ? null : { install: 'uv' }
  })
  return rows
}
