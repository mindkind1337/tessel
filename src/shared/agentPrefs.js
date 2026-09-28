// Per-agent settings (Settings > Agents), applied when a pane starts an
// agent: its own command, extra arguments, environment variables, and the
// permission mode. Yolo adds each agent's own "skip approvals" flag (table
// from Orca, github.com/stablyai/orca src/shared/tui-agent-permissions.ts,
// MIT, Copyright (c) 2026 Lovecast Inc.), except where you set arguments
// yourself. Manual adds nothing.

export const YOLO_ARGS = {
  claude: '--dangerously-skip-permissions',
  codex: '--dangerously-bypass-approvals-and-sandbox',
  gemini: '--yolo',
  qwen: '--approval-mode yolo',
  copilot: '--yolo',
  cline: '--auto-approve true',
  kimi: '--yolo',
  aider: '--yes-always',
  amp: '--dangerously-allow-all',
  cursor: '--yolo',
  crush: '--yolo',
  grok: '--permission-mode bypassPermissions',
  droid: '--auto high',
  openclaude: '--dangerously-skip-permissions',
  antigravity: '--dangerously-skip-permissions',
  commandcode: '--yolo',
  rovo: '--yolo',
  hermes: '--yolo',
  trae: '--yolo',
  kiro: '--trust-all-tools',
  autohand: '--unrestricted',
  continue: '--allow "*"',
  zcode: '--mode yolo',
  vibe: '--agent auto-approve',
  devin: '--permission-mode bypass --respect-workspace-trust false'
}
export const YOLO_ENV = { goose: { GOOSE_MODE: 'auto' } }

export const ENV_MAX_TEXT = 16 * 1024
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/

// "KEY=value" lines (blank lines and # comments ignored) -> { env } or { error }.
// Tessel's own TESSEL_* variables can never be changed this way.
export function parseEnvText(text) {
  const s = String(text || '')
  if (s.length > ENV_MAX_TEXT) return { error: 'Environment text is too large to use safely.' }
  const env = {}
  for (const raw of s.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq < 1) return { error: `"${line.slice(0, 40)}" is not NAME=value.` }
    const name = line.slice(0, eq).trim()
    if (!ENV_NAME.test(name)) return { error: `"${name.slice(0, 40)}" is not a valid variable name.` }
    if (/^TESSEL_/i.test(name)) return { error: `${name} is set by Tessel and cannot be changed.` }
    env[name] = line.slice(eq + 1).trim()
  }
  if (Object.keys(env).length > 50) return { error: 'At most 50 variables.' }
  return { env }
}

// What a pane runs for this agent: { command, args, env } (args: text added
// after the command; env: variables for the pane's shell).
export function effectiveAgent(agent, prefs = {}, permissions = 'manual') {
  const p = (prefs && prefs[agent.id]) || {}
  const command = typeof p.command === 'string' && p.command.trim() ? p.command.trim() : agent.command
  const own = typeof p.args === 'string' ? p.args.trim() : ''
  const args = own || (permissions === 'yolo' ? YOLO_ARGS[agent.id] || '' : '')
  const parsed = parseEnvText(p.env)
  const env = { ...(permissions === 'yolo' && !own ? YOLO_ENV[agent.id] || {} : {}), ...(parsed.env || {}) }
  return { command, args, env }
}

// Whether an agent is offered in Tessel's menus (on unless turned off).
export function agentEnabled(prefs, id) {
  return !(prefs && prefs[id] && prefs[id].enabled === false)
}

// How an agent was launched, to tell later whether its settings changed
// since (Settings > Agents): its command, arguments and variables.
export function launchSignature(launch) {
  if (!launch) return ''
  const env = Object.keys(launch.env || {})
    .sort()
    .map((k) => `${k}=${launch.env[k]}`)
  return JSON.stringify([launch.command || '', launch.args || '', env])
}

// Launched with its skip-approvals option (Yolo) in effect.
export function launchIsYolo(agentId, launch) {
  if (!launch) return false
  const flag = YOLO_ARGS[agentId]
  if (flag && (launch.args || '').includes(flag)) return true
  const env = YOLO_ENV[agentId]
  return !!env && Object.entries(env).every(([k, v]) => (launch.env || {})[k] === v)
}
