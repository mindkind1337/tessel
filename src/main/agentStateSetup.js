// Hook installation also serves agents outside teams. It touches only Tessel's
// own hook entries, in the actual provider home; approval/trust stays with CLI.
import fs from 'fs'
import os from 'os'
import { isAbsolute, join } from 'path'
import { installClaudeHooks, installCodexHooks, writeServerScript } from './teamInstall'

export function prepareAgentStateHooks({
  provider,
  sharedDir,
  source,
  home = os.homedir(),
  env = process.env
}) {
  if (provider !== 'claude' && provider !== 'codex') return { ok: true, supported: false }
  const variable = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const root =
    Object.entries(env).find(([key]) => key.toUpperCase() === variable)?.[1] ||
    join(home, `.${provider}`)
  if (typeof root !== 'string' || !isAbsolute(root))
    return {
      ok: false,
      error: 'Agent status hooks need an absolute provider configuration directory.'
    }
  try {
    const script = writeServerScript(sharedDir, source)
    // Equal or newer shared scripts are intentionally not overwritten by an
    // older app. Do not report a working installation without its protocol.
    if (!fs.readFileSync(script, 'utf8').includes('const AGENT_STATE_PROTOCOL = 1'))
      return {
        ok: false,
        error: 'The shared Tessel hook bridge needs updating before status hooks can run.'
      }
    const result =
      provider === 'codex'
        ? installCodexHooks(script, home, { configDir: root })
        : installClaudeHooks(script, home, { configDir: root })
    if (result.error) return { ok: false, error: result.error }
    return {
      ok: true,
      supported: true,
      changed: !!result.changed,
      needsReview: provider === 'codex' && !!result.changed
    }
  } catch {
    return {
      ok: false,
      error: 'Agent status hooks could not be installed. Existing agent settings were kept.'
    }
  }
}
