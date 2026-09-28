// Browser sign-in runs in its own private PTY, never in an agent's terminal.
// Orca's managed-login UX informed the link flow (MIT, Lovecast Inc., 2026).
// https://learn.chatgpt.com/docs/auth
// https://code.claude.com/docs/en/cli-reference
import fs from 'fs'
import os from 'os'
import { join, dirname, delimiter, isAbsolute } from 'path'
import { execFile } from 'child_process'
import { cleanEnv } from './cleanEnv'
import { extraToolDirs } from './toolDirs'
import { shimTarget } from './agentTools'

export const ACCOUNT_AUTH_ENV = {
  codex: [
    'CODEX_HOME',
    'OPENAI_API_KEY',
    'CODEX_API_KEY',
    'CODEX_ACCESS_TOKEN',
    'OPENAI_IDENTITY_TOKEN_FILE',
    'OPENAI_FEDERATION_RULE_ID',
    'OPENAI_WORKLOAD_IDENTITY_CONTEXT'
  ],
  claude: [
    'CLAUDE_CONFIG_DIR',
    'ANTHROPIC_API_KEY',
    'ANTHROPIC_AUTH_TOKEN',
    'CLAUDE_CODE_OAUTH_TOKEN',
    'CLAUDE_CODE_USE_BEDROCK',
    'CLAUDE_CODE_USE_VERTEX',
    'CLAUDE_CODE_USE_FOUNDRY'
  ]
}
const HOSTS = {
  codex: new Set(['auth.openai.com', 'chatgpt.com']),
  claude: new Set([
    'claude.ai',
    'console.anthropic.com',
    'platform.claude.com',
    'console.claude.com'
  ])
}
export function accountLoginUrl(provider, output) {
  // Wait for a delimiter: a chunk ending in the middle of an OAuth URL must
  // never become the copyable login link. Ignore update/documentation links.
  const text = String(output).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
  for (const match of text.matchAll(/https:\/\/[^\s\x00-\x1f]+(?=\s)/g)) {
    try {
      const url = new URL(match[0])
      if (
        HOSTS[provider]?.has(url.hostname) &&
        !url.username &&
        !url.password &&
        (!url.port || url.port === '443') &&
        /(?:oauth|authorize|login)/i.test(url.pathname)
      )
        return url.href
    } catch {
      /* partial or unsupported link */
    }
  }
  return null
}

export function loginEnvironment(provider, home, base = process.env) {
  if (!ACCOUNT_AUTH_ENV[provider] || !isAbsolute(home)) throw new Error('Invalid sign-in request.')
  const env = cleanEnv(base)
  const remove = new Set(
    [
      ...ACCOUNT_AUTH_ENV.codex,
      ...ACCOUNT_AUTH_ENV.claude,
      'HOME',
      'USERPROFILE',
      'CLAUDE_CONFIG_DIR',
      'CODEX_HOME'
    ].map((key) => key.toUpperCase())
  )
  for (const key of Object.keys(env)) if (remove.has(key.toUpperCase())) delete env[key]
  env.HOME = home
  env.USERPROFILE = home
  env[provider === 'codex' ? 'CODEX_HOME' : 'CLAUDE_CONFIG_DIR'] = home
  return env
}

export function resolveAccountCommand(
  provider,
  {
    env = process.env,
    home = os.homedir(),
    platform = process.platform,
    toolDirs = extraToolDirs(env, home),
    exists = fs.existsSync,
    read = fs.readFileSync
  } = {}
) {
  if (!ACCOUNT_AUTH_ENV[provider]) throw new Error('Unknown account provider.')
  const path = Object.entries(env).find(([key]) => key.toLowerCase() === 'path')?.[1] || ''
  const dirs = [...path.split(platform === 'win32' ? ';' : delimiter), ...toolDirs].filter(
    (dir) => dir && isAbsolute(dir)
  )
  const find = (names) => {
    for (const dir of dirs)
      for (const name of names) {
        const file = join(dir, name)
        if (exists(file)) return file
      }
    return null
  }
  const file = find(platform === 'win32' ? [`${provider}.exe`, `${provider}.cmd`] : [provider])
  if (!file)
    throw new Error(
      `Install ${provider === 'claude' ? 'Claude Code' : 'Codex'} before adding an account.`
    )
  if (platform !== 'win32' || /\.exe$/i.test(file)) return { file, pre: [] }
  // Resolve known npm launchers to a real executable; no cmd.exe or shell
  // interpolation of paths/arguments, regardless of PowerShell policy.
  const target = shimTarget(read(file, 'utf8'), dirname(file), find(['node.exe']), exists)
  if (!target) throw new Error(`The ${provider} launcher could not be resolved. Reinstall its CLI.`)
  return target
}

async function defaultSpawn(file, args, opts) {
  const pty = await import('node-pty')
  return (pty.spawn || pty.default.spawn)(file, args, opts)
}
function statusCommand(file, args, options) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      { ...options, windowsHide: true, timeout: 20000, maxBuffer: 256 * 1024 },
      (error, stdout) => {
        if (error) return resolve({ ok: false })
        try {
          resolve({ ok: true, status: JSON.parse(stdout) })
        } catch {
          resolve({ ok: false })
        }
      }
    )
  })
}
async function terminate(child, platform) {
  // Wait for onExit before callers can remove a temporary home. Killing the
  // owned process tree prevents a launcher child writing to it after cleanup.
  if (platform === 'win32' && Number.isInteger(child.pid) && child.pid > 0) {
    await new Promise((resolve) =>
      execFile(
        'taskkill.exe',
        ['/PID', String(child.pid), '/T', '/F'],
        { windowsHide: true, timeout: 10000 },
        () => resolve()
      )
    )
  }
  try {
    child.kill()
  } catch {
    /* onExit may already have fired */
  }
}

export function createProviderLogin({
  env = process.env,
  home: systemHome = os.homedir(),
  platform = process.platform,
  resolveCommand = resolveAccountCommand,
  spawnPty = defaultSpawn,
  runStatus = statusCommand,
  kill = terminate,
  timeoutMs = 10 * 60 * 1000,
  teardownMs = 10000
} = {}) {
  return async ({ provider, home, signal, onProgress = () => {} }) => {
    if (signal?.aborted) return { ok: false, error: 'Sign-in cancelled.' }
    let command, child
    const childEnv = loginEnvironment(provider, home, env)
    try {
      command = await resolveCommand(provider, { env, home: systemHome, platform })
      child = await spawnPty(
        command.file,
        [...command.pre, ...(provider === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'])],
        { cwd: home, env: childEnv, name: 'xterm-256color', cols: 4096, rows: 30 }
      )
    } catch {
      return {
        ok: false,
        error: `Could not start ${provider} sign-in. Check that its CLI is installed.`
      }
    }
    const loggedIn = await new Promise((resolve) => {
      let output = '',
        lastUrl = null,
        aborted = false,
        timedOut = false,
        settled = false
      let dataSub, exitSub, timer, teardownTimer
      const stop = (timeout = false) => {
        if (settled || aborted || timedOut) return
        timedOut = timeout
        aborted = !timeout
        // A failed kill or a lost exit event must not hang the app's Quit.
        // Callers preserve the marked staging home unless death is confirmed.
        teardownTimer = setTimeout(() => finish({ unconfirmed: true }), teardownMs)
        Promise.resolve()
          .then(() => kill(child, platform))
          .catch(() => {})
      }
      const onAbort = () => stop(false)
      const finish = ({ exitCode, unconfirmed = false }) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(teardownTimer)
        signal?.removeEventListener('abort', onAbort)
        dataSub?.dispose()
        exitSub?.dispose()
        resolve(
          unconfirmed
            ? {
                ok: false,
                cleanupSafe: false,
                error: 'Sign-in could not be stopped. Its temporary files were retained.'
              }
            : aborted
              ? { ok: false, error: 'Sign-in cancelled.' }
              : timedOut
                ? { ok: false, error: 'Sign-in timed out. Try again.' }
                : exitCode === 0
                  ? { ok: true }
                  : { ok: false, error: 'Sign-in did not complete. Try again.' }
        )
      }
      exitSub = child.onExit(finish)
      dataSub = child.onData((chunk) => {
        output = (output + String(chunk)).slice(-64 * 1024)
        const url = accountLoginUrl(provider, output)
        if (url && url !== lastUrl) {
          lastUrl = url
          try {
            onProgress({ url })
          } catch {
            /* observer cannot stop sign-in */
          }
        }
      })
      timer = setTimeout(() => stop(true), timeoutMs)
      signal?.addEventListener('abort', onAbort, { once: true })
      if (signal?.aborted) stop(false)
    })
    if (!loggedIn.ok || provider !== 'claude') return loggedIn
    if (signal?.aborted) return { ok: false, error: 'Sign-in cancelled.' }
    // Status is used privately to prove which account was authenticated.
    // Neither stdout nor tokens are ever sent to the renderer or the log.
    try {
      const result = await runStatus(command.file, [...command.pre, 'auth', 'status', '--json'], {
        cwd: home,
        env: childEnv,
        signal
      })
      return result.ok ? result : { ok: false, error: 'Could not verify the signed-in account.' }
    } catch {
      return { ok: false, error: 'Could not verify the signed-in account.' }
    }
  }
}
