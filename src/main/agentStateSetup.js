// Hook installation also serves agents outside teams. It touches only Tessel's
// own hook entries, in the actual provider home; approval/trust stays with CLI.
import fs from 'fs'
import os from 'os'
import { isAbsolute, join } from 'path'
import {
  installClaudeHooks,
  installCodexHooks,
  installGeminiHooks,
  installCopilotHooks,
  installOpencodePlugin,
  installKimiHooks,
  writeServerScript
} from './teamInstall'
import { installStatusHooks, removeStatusHooks, STATUS_HOOK_AGENTS, STATUS_HOOKS } from './agentStatusHooks'
import { hookNode } from './nodePath'
import { STATUS_PROVIDERS } from '../shared/agentStateModel'
import { t } from './i18n'

// The agents whose own hooks (team messages and status) Tessel installs for
// every launch, like Claude Code's and Codex's.
const TEAM_HOOKS = {
  gemini: (script, home, env, node) => installGeminiHooks(script, home, { node }),
  copilot: (script, home, env, node) => installCopilotHooks(script, home, { node }),
  opencode: (script, home, env, node) => installOpencodePlugin(script, home, { node }),
  kimi: (script, home, env, node, kimiValidate) =>
    installKimiHooks(script, home, {
      node,
      kimiHome: Object.entries(env).find(([key]) => key.toUpperCase() === 'KIMI_CODE_HOME')?.[1],
      ...(kimiValidate ? { validate: kimiValidate } : {})
    })
}

// -> { ok, supported, changed?, needsReview? } or { ok: false, error }. Async:
// Kimi's settings are checked by Kimi itself before they are written.
// Every hook runs node by its absolute path, found on the pane's PATH (never
// the project folder); none found: nothing is installed. `optIn`: the
// agents whose hooks the user turned on in Settings (Cursor's are off by
// default, and Tessel's entries are removed while they are off).
export async function prepareAgentStateHooks({
  provider,
  sharedDir,
  source,
  home = os.homedir(),
  env = process.env,
  kimiValidate,
  optIn = {},
  node
}) {
  if (!STATUS_PROVIDERS.includes(provider)) return { ok: true, supported: false }
  if (STATUS_HOOKS[provider]?.optIn && optIn[provider] !== true) {
    const removed = removeStatusHooks(provider, { home, env })
    return removed.error ? { ok: false, error: removed.error } : { ok: true, supported: false, optedOut: true }
  }
  const classic = provider === 'claude' || provider === 'codex'
  const variable = provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'
  const root = classic
    ? Object.entries(env).find(([key]) => key.toUpperCase() === variable)?.[1] || join(home, `.${provider}`)
    : home
  if (typeof root !== 'string' || !isAbsolute(root))
    return {
      ok: false,
      error: t('main.hooks.statusAbsolute', 'Agent status hooks need an absolute provider configuration directory.')
    }
  try {
    const script = writeServerScript(sharedDir, source)
    const found = hookNode(script, node, env)
    if (found.error) return { ok: false, error: found.error }
    // Equal or newer shared scripts are intentionally not overwritten by an
    // older app. Do not report a working installation without its protocol
    // (and, for the other agents, without their events).
    const shared = fs.readFileSync(script, 'utf8')
    if (!shared.includes('const AGENT_STATE_PROTOCOL = 1') || (!classic && !/const AGENT_STATUS_AGENTS = [2-9]/.test(shared)))
      return {
        ok: false,
        error: t('main.hooks.bridgeOutdated', 'The shared Tessel hook bridge needs updating before status hooks can run.')
      }
    const result =
      provider === 'codex'
        ? installCodexHooks(script, home, { configDir: root, node: found.node })
        : provider === 'claude'
          ? installClaudeHooks(script, home, { configDir: root, node: found.node })
          : TEAM_HOOKS[provider]
            ? await TEAM_HOOKS[provider](script, home, env, found.node, kimiValidate)
            : STATUS_HOOK_AGENTS.includes(provider)
              ? installStatusHooks(provider, script, { home, env, node: found.node })
              : { changed: false }
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
      error: t('main.hooks.statusInstallFailed', 'Agent status hooks could not be installed. Existing agent settings were kept.')
    }
  }
}
