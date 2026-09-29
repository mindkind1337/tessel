// One-shot agent runs that only produce text (a commit message), after Orca's
// commit-message generation (src/shared/commit-message-agent-specs-primary.ts
// and src/main/text-generation/source-control-local-process.ts, MIT,
// Copyright (c) 2026 Lovecast Inc.): the prompt goes on stdin (a staged diff
// is too long for a command line), the agent runs read-only, the answer is
// read from stdout. The program is found on the fresh PATH and started
// directly with an argument array: no shell reads the arguments.
import fs from 'fs'
import os from 'os'
import { dirname } from 'path'
import { spawn } from 'child_process'
import { run, shimTarget, psQuote } from './agentTools'
import { cleanEnv } from './cleanEnv'
import { t } from './i18n'

// Orca's arguments for a text-only answer.
export const HEADLESS = {
  claude: { exe: 'claude', args: ['-p', '--output-format', 'text', '--model', 'haiku', '--permission-mode', 'plan'] },
  codex: { exe: 'codex', args: ['exec', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only'] }
}

const PS_PATH =
  "$env:Path = [Environment]::GetEnvironmentVariable('Path','Machine') + ';' + [Environment]::GetEnvironmentVariable('Path','User')"

// The program behind a command name: -> { file, pre, path } or null.
export async function resolveProgram(exe) {
  if (process.platform !== 'win32') return { file: exe, pre: [], path: process.env.PATH || '' }
  const probe = [
    PS_PATH,
    '[Console]::OutputEncoding = [Text.Encoding]::UTF8',
    `$c = Get-Command -CommandType Application -Name ${psQuote(exe)} -ErrorAction SilentlyContinue | Select-Object -First 1`,
    "$n = Get-Command -CommandType Application -Name 'node' -ErrorAction SilentlyContinue | Select-Object -First 1",
    'ConvertTo-Json -Compress @{ app = [string]$c.Source; node = [string]$n.Source; path = $env:Path }'
  ].join('; ')
  const res = await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', probe], { timeout: 20000 })
  let found = null
  try {
    found = JSON.parse(res.stdout.trim())
  } catch {
    return null
  }
  const app = found && found.app
  if (app && /\.exe$/i.test(app)) return { file: app, pre: [], path: found.path }
  if (app && /\.cmd$/i.test(app)) {
    try {
      const t = shimTarget(fs.readFileSync(app, 'utf8'), dirname(app), found.node || null)
      return t ? { ...t, path: found.path } : null
    } catch {
      return null
    }
  }
  return null
}

const running = new Map() // key -> child

// Run `agent` ('claude' | 'codex') with `input` on stdin. -> { ok, text } |
// { ok: false, error, cancelled }. key: one run per key; cancel(key) stops it.
export async function runHeadless(agent, input, { cwd, key = 'default', timeout = 120000 } = {}) {
  const spec = HEADLESS[agent]
  if (!spec) return { ok: false, error: t('main.agents.pickAgent', 'Pick Claude or Codex to generate the message.') }
  if (running.has(key)) return { ok: false, error: t('main.agents.alreadyGenerating', 'A message is already being generated.') }
  running.set(key, null)
  try {
    const prog = await resolveProgram(spec.exe)
    if (!prog) return { ok: false, error: t('main.agents.notFound', '{{agent}} was not found on this computer.', { agent: agent === 'claude' ? 'Claude Code' : 'Codex' }) }
    if (!running.has(key)) return { ok: false, cancelled: true, error: t('main.agents.stopped', 'Stopped.') }
    const env = { ...cleanEnv(process.env) }
    for (const k of Object.keys(env)) if (k.toLowerCase() === 'path') delete env[k]
    env.Path = prog.path || process.env.PATH || ''
    return await new Promise((done) => {
      let out = ''
      let err = ''
      let finished = false
      const child = spawn(prog.file, [...prog.pre, ...spec.args], {
        cwd: cwd && fs.existsSync(cwd) ? cwd : os.homedir(),
        env,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe']
      })
      running.set(key, child)
      const end = (res) => {
        if (finished) return
        finished = true
        clearTimeout(timer)
        done(res)
      }
      const timer = setTimeout(() => {
        try {
          child.kill()
        } catch {
          /* gone */
        }
        end({ ok: false, error: t('main.agents.tooLong', 'The agent took too long to answer.') })
      }, timeout)
      child.stdout.on('data', (d) => {
        if (out.length < 200000) out += d
      })
      child.stderr.on('data', (d) => {
        if (err.length < 20000) err += d
      })
      child.on('error', (e) => end({ ok: false, error: t('main.agents.couldNotStart', 'Could not start {{exe}}: {{error}}', { exe: spec.exe, error: e.message }) }))
      child.on('close', (code) => {
        if (child.cancelled) return end({ ok: false, cancelled: true, error: t('main.agents.stopped', 'Stopped.') })
        if (code === 0 && out.trim()) return end({ ok: true, text: out })
        const line = (err || out).trim().split(/\r?\n/).filter(Boolean).slice(-2).join(' ')
        end({ ok: false, error: line.slice(0, 400) || t('main.agents.noAnswer', '{{exe}} gave no answer.', { exe: spec.exe }) })
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    })
  } finally {
    running.delete(key)
  }
}

export function cancelHeadless(key = 'default') {
  if (!running.has(key)) return false
  const child = running.get(key)
  running.delete(key)
  if (child) {
    child.cancelled = true
    try {
      child.kill()
    } catch {
      /* gone */
    }
  }
  return true
}
