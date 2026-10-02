// How agents without an npm package install: each vendor's own Windows
// installer, taken from its own docs (installSource), or only a link to its
// install page (docsUrl) when there is no automatic Windows install.
//
// Static data: nothing here is ever built from what the window sends. An
// install that is not a plain `npm install -g` or `winget install --id` (a
// script downloaded from the internet, pip...) is shown to the user, exactly
// as it will run, and runs only once they confirm (App.vue installAgent).
//
// install: the steps, verbatim from the vendor's docs; installShell: the
// shell they are written for (Tessel's shell ids); installSource: the page
// they come from; allowedDomains: where they may download from ("host" or
// "host/path/"), checked by checkInstall() before the window ever sees them.

export const SHELL_IDS = ['powershell', 'pwsh', 'cmd', 'gitbash', 'wsl']

const PS = 'powershell'

export const AGENT_INSTALLS = {
  // --- The vendor's own installer, downloaded and run (confirmed first) ---
  kimi: {
    install: ['irm https://code.kimi.com/kimi-code/install.ps1 | iex'],
    installShell: PS,
    installSource: 'https://code.kimi.com/kimi-code',
    allowedDomains: ['code.kimi.com']
  },
  aider: {
    // pip, then aider's own installer (it sets up its Python itself).
    install: ['python -m pip install aider-install', 'aider-install'],
    installShell: null,
    installSource: 'https://aider.chat/docs/install.html',
    allowedDomains: ['aider.chat']
  },
  cursor: {
    install: ["irm 'https://cursor.com/install?win32=true' | iex"],
    installShell: PS,
    installSource: 'https://cursor.com/docs/cli/installation',
    allowedDomains: ['cursor.com']
  },
  grok: {
    install: ['irm https://x.ai/cli/install.ps1 | iex'],
    installShell: PS,
    installSource: 'https://docs.x.ai/build/overview',
    allowedDomains: ['x.ai']
  },
  antigravity: {
    install: ['irm https://antigravity.google/cli/install.ps1 | iex'],
    installShell: PS,
    installSource: 'https://antigravity.google/docs/cli/install',
    allowedDomains: ['antigravity.google']
  },
  hermes: {
    install: ['iex (irm https://hermes-agent.nousresearch.com/install.ps1)'],
    installShell: PS,
    installSource: 'https://hermes-agent.nousresearch.com/docs/getting-started/installation',
    allowedDomains: ['hermes-agent.nousresearch.com']
  },
  devin: {
    // Its docs: PowerShell only (not Git Bash or cmd).
    install: ['irm https://static.devin.ai/cli/setup.ps1 | iex'],
    installShell: PS,
    installSource: 'https://docs.devin.ai/cli',
    allowedDomains: ['devin.ai']
  },
  omp: {
    install: ['irm https://omp.sh/install.ps1 | iex'],
    installShell: PS,
    installSource: 'https://github.com/can1357/oh-my-pi',
    allowedDomains: ['omp.sh', 'github.com/can1357/oh-my-pi']
  },
  muse: {
    install: ['irm https://dev.meta.ai/install.ps1 | iex'],
    installShell: PS,
    installSource: 'https://dev.meta.ai/docs/muse-code',
    allowedDomains: ['dev.meta.ai']
  },
  qoder: {
    // Its Windows PowerShell installer (the npm package is "legacy" there).
    install: ['irm https://qoder.com/install.ps1 | iex'],
    installShell: PS,
    installSource: 'https://docs.qoder.com/cli/installation',
    allowedDomains: ['qoder.com']
  },

  // --- An npm package published by the vendor (no confirmation, npm updates) ---
  openclaude: { install: ['npm install -g @gitlawb/openclaude'], installSource: 'https://github.com/Gitlawb/openclaude' },
  autohand: { install: ['npm install -g autohand-cli'], installSource: 'https://docs.autohand.ai/working-with-autohand-code/cli' },
  commandcode: { install: ['npm install -g command-code'], installSource: 'https://commandcode.ai/docs/quickstart' },
  openclaw: { install: ['npm install -g openclaw'], installSource: 'https://docs.openclaw.ai/install' },
  mimocode: { install: ['npm install -g @mimo-ai/cli'], installSource: 'https://github.com/XiaomiMiMo/MiMo-Code' },
  freebuff: { install: ['npm install -g freebuff'], installSource: 'https://freebuff.com/cli' },

  // --- No automatic Windows install: a link to the install page only ---
  // Script saves into the current folder and does not touch PATH.
  goose: { docsUrl: 'https://goose-docs.ai/docs/getting-started/installation' },
  // Docs list Windows through WSL only.
  auggie: { docsUrl: 'https://docs.augmentcode.com/cli/setup-auggie/install-auggie-cli' },
  // Windows 11 is supported, but its docs page shows no Windows command.
  kiro: { docsUrl: 'https://kiro.dev/docs/getting-started/installation/' },
  // Officially targets UNIX; on Windows only through uv or pip by hand.
  vibe: { docsUrl: 'https://github.com/mistralai/mistral-vibe' },
  // A bare acli.exe download; Rovo Dev runs as `acli rovodev`.
  rovo: { docsUrl: 'https://developer.atlassian.com/cloud/acli/guides/install-windows/' },
  // Served from mainland China only, with an enterprise sign-in.
  trae: { docsUrl: 'https://docs.trae.cn/cli_get-started-with-trae-code-cli-2' },
  // Desktop installer only; the CLI is built from source.
  zcode: { docsUrl: 'https://zcode.z.ai/' },
  // Its npm package also installs `opencode`, which clashes with OpenCode.
  opencode2: { docsUrl: 'https://opencode.ai/v2/docs/' },
  // macOS and Linux only.
  primeagent: { docsUrl: 'https://github.com/PrimeIntellect-ai/prime-agent' },
  ante: { docsUrl: 'https://github.com/AntigmaLabs/ante-preview' },
  // DeepSeek's npm package ships `dsh` only; the `dsh-tui` launcher of its
  // interactive profile is a separate, community package.
  dsh: { docsUrl: 'https://deepseek-harness.github.io/deepseek-harness/' }
}

// --- Checks -------------------------------------------------------------------
const NPM_GLOBAL = /^npm install -g (--ignore-scripts )?(@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i
const WINGET_ID = /^winget install --id [A-Za-z0-9][A-Za-z0-9.+_-]* -e$/
// Downloads and runs something from the internet.
const REMOTE = /https?:\/\/|\b(irm|iwr|iex|curl|wget|Invoke-RestMethod|Invoke-WebRequest|Invoke-Expression)\b/i
const URLS = /https?:\/\/[^\s"'`|;)]+/gi

// A plain package-manager install: no confirmation needed.
export function isPlainInstall(steps) {
  const list = Array.isArray(steps) ? steps : []
  return list.length > 0 && list.every((s) => typeof s === 'string' && (NPM_GLOBAL.test(s.trim()) || WINGET_ID.test(s.trim())))
}

export function isRemoteScript(steps) {
  return (Array.isArray(steps) ? steps : []).some((s) => REMOTE.test(String(s)))
}

export function urlsIn(steps) {
  return (Array.isArray(steps) ? steps : []).flatMap((s) => String(s).match(URLS) || [])
}

// https, on one of the allowed domains (or its subdomains), under the
// allowed path when the entry has one.
export function onAllowedDomain(url, allowed) {
  let u
  try {
    u = new URL(url)
  } catch {
    return false
  }
  if (u.protocol !== 'https:' || u.username || u.password || u.port) return false
  const host = u.hostname.toLowerCase()
  return (Array.isArray(allowed) ? allowed : []).some((entry) => {
    const e = String(entry || '').toLowerCase()
    const slash = e.indexOf('/')
    const domain = slash < 0 ? e : e.slice(0, slash)
    const path = slash < 0 ? '' : e.slice(slash)
    if (!domain || !(host === domain || host.endsWith('.' + domain))) return false
    return !path || u.pathname.toLowerCase().startsWith(path)
  })
}

function httpsUrl(url) {
  try {
    return new URL(url).protocol === 'https:'
  } catch {
    return false
  }
}

// What the window gets for a preset: its install (only when every check
// passes), whether it must be confirmed, its shell and source; else its
// install page. -> { install, installShell, installSource, installConfirm, docsUrl }
export function checkInstall(preset) {
  const p = preset || {}
  const steps = Array.isArray(p.install) ? p.install.filter((s) => typeof s === 'string' && s.trim()) : null
  const docsUrl = typeof p.docsUrl === 'string' && httpsUrl(p.docsUrl) ? p.docsUrl : null
  const none = { install: null, installShell: null, installSource: null, installConfirm: false, docsUrl }
  if (!steps || !steps.length) return none
  const shell = p.installShell == null ? null : p.installShell
  if (shell !== null && !SHELL_IDS.includes(shell)) return none
  if (isPlainInstall(steps)) {
    return { install: steps, installShell: shell, installSource: httpsUrl(p.installSource) ? p.installSource : null, installConfirm: false, docsUrl }
  }
  // Anything else is confirmed first, and says where it comes from.
  const allowed = p.allowedDomains
  if (!onAllowedDomain(p.installSource, allowed)) return { ...none, docsUrl: docsUrl || null }
  if (isRemoteScript(steps)) {
    const urls = urlsIn(steps)
    // A script install names its shell and only downloads from its vendor.
    if (!shell || !urls.length || !urls.every((u) => onAllowedDomain(u, allowed))) return { ...none, docsUrl: docsUrl || p.installSource }
  }
  return { install: steps, installShell: shell, installSource: p.installSource, installConfirm: true, docsUrl }
}
