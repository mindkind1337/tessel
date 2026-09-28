// The environment of a new pane's shell: Tessel's own environment, then the
// agent's variables (Settings > Agents), then its provider account's.

// Inherited sign-in variables a managed account may remove, so they can't win
// over it (only these known names).
export const UNSETTABLE = [
  'ANTHROPIC_API_KEY',
  'ANTHROPIC_AUTH_TOKEN',
  'CLAUDE_CODE_OAUTH_TOKEN',
  'CLAUDE_CONFIG_DIR',
  'CLAUDE_CODE_USE_BEDROCK',
  'CLAUDE_CODE_USE_VERTEX',
  'CLAUDE_CODE_USE_FOUNDRY',
  'OPENAI_API_KEY',
  'CODEX_ACCESS_TOKEN',
  'CODEX_API_KEY',
  'CODEX_HOME',
  'OPENAI_IDENTITY_TOKEN_FILE',
  'OPENAI_FEDERATION_RULE_ID',
  'OPENAI_WORKLOAD_IDENTITY_CONTEXT'
]

// Checked names, at most 50, never Tessel's own TESSEL_*. Each source is
// checked on its own, so the agent's variables never crowd out the account's.
export function checkedEnv(src) {
  const out = {}
  if (!src || typeof src !== 'object' || Array.isArray(src)) return out
  for (const [k, v] of Object.entries(src).slice(0, 50)) {
    if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(k) && !/^TESSEL_/i.test(k) && typeof v === 'string' && v.length <= 8192) out[k] = v
  }
  return out
}

// Windows variable names ignore case: a later layer replaces the same name in
// any spelling, so two spellings never leave which one applies to chance.
function overlay(env, layer) {
  for (const name of Object.keys(layer)) {
    const up = name.toUpperCase()
    for (const k of Object.keys(env)) if (k.toUpperCase() === up) delete env[k]
    env[name] = layer[name]
  }
  return env
}

// -> the pane's variables (without TESSEL_PANE_ID / TESSEL_PROJECT_DIR, which
// the caller adds last).
export function paneEnv(base, { extraEnv, accountEnv, unsetEnv } = {}) {
  const env = { ...base }
  if (Array.isArray(unsetEnv)) {
    for (const name of unsetEnv) {
      if (typeof name !== 'string' || !UNSETTABLE.includes(name.toUpperCase())) continue
      for (const k of Object.keys(env)) if (k.toUpperCase() === name.toUpperCase()) delete env[k]
    }
  }
  overlay(env, checkedEnv(extraEnv))
  overlay(env, checkedEnv(accountEnv))
  return env
}
