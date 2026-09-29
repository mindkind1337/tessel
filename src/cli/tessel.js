// The tessel command: talks to the running Tessel over its command-line pipe
// (src/main/cliServer.js has the protocol and the security). Settings >
// General > Tessel CLI installs a tessel.cmd that runs this file with
// Tessel's own executable as Node (src/main/cliInstall.js).
//
// Self-contained on purpose (Node built-ins only): it is bundled alone into
// out/main/cli.js, unpacked from the app archive.
// Named imports only: a default import makes the bundler share an interop
// helper chunk with the app's bundle.
import { existsSync, readFileSync } from 'node:fs'
import { createConnection } from 'node:net'
import { join, resolve } from 'node:path'
import { spawn } from 'node:child_process'

// Same values as cliServer.js (a test checks they agree).
export const CLI_PROTOCOL = 'TESSEL-CLI 1'
export const MAX_REQUEST_BYTES = 64 * 1024
export const MAX_REPLY_BYTES = 1024 * 1024
export const RUNTIME_FILE = 'cli-runtime.json'
export const TOKEN_FILE = 'cli.token'

export const EXIT = { ok: 0, failed: 1, usage: 2, notRunning: 3 }

// --- Words (English, French when Tessel's interface is in French) --------------------

const FR = {
  'Tessel is not running.': 'Tessel n’est pas ouvert.',
  'Start Tessel, or run the command again with --start.': 'Ouvrez Tessel, ou relancez la commande avec --start.',
  'Start Tessel first (the development build is not started by the command).': 'Ouvrez d’abord Tessel (la version de développement n’est pas lancée par la commande).',
  'Starting Tessel…': 'Ouverture de Tessel…',
  'Tessel did not start in time.': 'Tessel ne s’est pas ouvert à temps.',
  'Could not reach Tessel: {{error}}': 'Impossible de joindre Tessel : {{error}}',
  'Tessel did not answer in time.': 'Tessel n’a pas répondu à temps.',
  'Tessel sent an answer the command cannot read.': 'Tessel a envoyé une réponse illisible pour la commande.',
  'The tessel command is not registered correctly: register it again in Tessel (Settings > General > Tessel CLI).':
    'La commande tessel n’est pas bien enregistrée : enregistrez-la de nouveau dans Tessel (Paramètres > Général > Tessel CLI).',
  'Unknown command: {{cmd}}': 'Commande inconnue : {{cmd}}',
  'Unknown option: {{opt}}': 'Option inconnue : {{opt}}',
  '{{opt}} needs a value.': '{{opt}} demande une valeur.',
  'Not found: {{path}}': 'Introuvable : {{path}}',
  'The card needs a title.': 'La carte doit avoir un titre.',
  'Opened the project {{name}}.': 'Projet {{name}} ouvert.',
  'Opened {{file}} in the editor.': '{{file}} ouvert dans l’éditeur.',
  'Opened a new pane in {{name}}: {{pane}}.': 'Nouveau panneau ouvert dans {{name}} : {{pane}}.',
  'Added the card “{{title}}” to the task board of {{name}}.': 'Carte « {{title}} » ajoutée au tableau des tâches de {{name}}.',
  'Tessel is in front.': 'Tessel est au premier plan.',
  'No project is open.': 'Aucun projet n’est ouvert.',
  '{{count}} projects, {{panes}} panes': '{{count}} projets, {{panes}} panneaux',
  'No usage information.': 'Aucune information d’utilisation.',
  'resets {{when}}': 'réinitialisation {{when}}',
  'not available': 'indisponible',
  'terminal': 'terminal',
  'agent': 'agent',
  'editor': 'éditeur',
  'active': 'actif',
  'The request is too long.': 'La demande est trop longue.'
}

let locale = 'en'
export function setLocale(l) {
  locale = String(l || '').toLowerCase().startsWith('fr') ? 'fr' : 'en'
}
export function tr(text, vars = {}) {
  const s = (locale === 'fr' && FR[text]) || text
  return s.replace(/\{\{\s*(\w+)\s*\}\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])))
}

export function helpText(name = 'tessel') {
  const fr = locale === 'fr'
  const rows = [
    ['.', fr ? 'Ouvrir le dossier courant comme projet' : 'Open the current folder as a project'],
    [fr ? 'open [chemin[:ligne]]' : 'open [path[:line]]', fr ? 'Ouvrir un dossier (projet) ou un fichier (éditeur)' : 'Open a folder (project) or a file (editor)'],
    ['new [--agent <id>] [--model <m>] [--effort <e>] [--shell <id>]', fr ? 'Nouveau terminal ou agent dans le projet courant' : 'New terminal or agent pane in the current project'],
    ['focus', fr ? 'Mettre Tessel au premier plan' : 'Bring Tessel to the front'],
    ['status [--json]', fr ? 'Projets, panneaux et état des agents' : 'Projects, panes and agent states'],
    [fr ? 'task add <titre> [--note <texte>]' : 'task add <title> [--note <text>]', fr ? 'Ajouter une carte au tableau des tâches' : 'Add a card to the task board'],
    ['usage [--json]', fr ? 'Utilisation des fournisseurs d’IA' : 'AI provider usage']
  ]
  const width = 34
  const lines = rows.map(([cmd, what]) => {
    const left = `  ${name} ${cmd}`
    return left.length < width ? `${left.padEnd(width)}${what}` : `${left}\n${' '.repeat(width)}${what}`
  })
  const head = fr ? `Utilisation : ${name} <commande> [options]` : `Usage: ${name} <command> [options]`
  const foot = fr
    ? ['Options : --start (ouvrir Tessel s’il ne l’est pas), --no-start, --json, --help, --version', 'Le projet courant est celui qui contient le dossier où vous êtes, sinon le projet actif.']
    : ['Options: --start (start Tessel when it is not running), --no-start, --json, --help, --version', 'The current project is the one containing the folder you are in, else the active project.']
  return [head, '', ...lines, '', ...foot].join('\n')
}

// --- Arguments ---------------------------------------------------------------------

export class UsageError extends Error {}

const VALUE_OPTS = new Set(['--agent', '--model', '--effort', '--shell', '--note', '--line', '--col'])
const FLAG_OPTS = new Set(['--start', '--no-start', '--json', '--help', '-h', '--version', '-v'])

// -> { cmd, args: [...], opts: { agent, … , start, json } }
export function parseArgs(argv) {
  const opts = {}
  const args = []
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i])
    if (a === '--') {
      args.push(...argv.slice(i + 1).map(String))
      break
    }
    if (a.startsWith('--') && a.includes('=')) {
      const [k, ...rest] = a.split('=')
      if (!VALUE_OPTS.has(k)) throw new UsageError(tr('Unknown option: {{opt}}', { opt: k }))
      opts[k.slice(2)] = rest.join('=')
      continue
    }
    if (VALUE_OPTS.has(a)) {
      if (i + 1 >= argv.length) throw new UsageError(tr('{{opt}} needs a value.', { opt: a }))
      opts[a.slice(2)] = String(argv[++i])
      continue
    }
    if (FLAG_OPTS.has(a)) {
      if (a === '-h' || a === '--help') opts.help = true
      else if (a === '-v' || a === '--version') opts.version = true
      else if (a === '--no-start') opts.start = false
      else opts[a.slice(2)] = true
      continue
    }
    if (a.startsWith('-') && a !== '-') throw new UsageError(tr('Unknown option: {{opt}}', { opt: a }))
    args.push(a)
  }
  const cmd = args.shift() || null
  return { cmd, args, opts }
}

// A path as typed, with an optional :line[:col] (src\a.js:12:3) when the
// file exists without it.
export function resolveTarget(input, cwd, exists = existsSync) {
  const raw = input == null || input === '' ? '.' : String(input)
  const full = resolve(cwd, raw)
  if (exists(full)) return { path: full, line: null, col: null }
  const m = /^(.*?):(\d+)(?::(\d+))?$/.exec(raw)
  if (m && m[1] && exists(resolve(cwd, m[1])))
    return { path: resolve(cwd, m[1]), line: Number(m[2]), col: m[3] ? Number(m[3]) : null }
  return { path: full, line: null, col: null, missing: true }
}

const positiveInt = (v) => (v == null ? null : /^\d{1,8}$/.test(String(v)) && Number(v) > 0 ? Number(v) : NaN)

// -> { method, params, autoStart } (throws UsageError).
export function buildRequest({ cmd, args, opts }, cwd, exists = existsSync) {
  switch (cmd) {
    case 'open': {
      if (args.length > 1) throw new UsageError(tr('Unknown command: {{cmd}}', { cmd: args.slice(1).join(' ') }))
      const target = resolveTarget(args[0], cwd, exists)
      if (target.missing) throw new UsageError(tr('Not found: {{path}}', { path: target.path }))
      const line = opts.line != null ? positiveInt(opts.line) : target.line
      const col = opts.col != null ? positiveInt(opts.col) : target.col
      if (Number.isNaN(line) || Number.isNaN(col)) throw new UsageError(tr('{{opt}} needs a value.', { opt: Number.isNaN(line) ? '--line' : '--col' }))
      return { method: 'open', params: { path: target.path, ...(line ? { line } : {}), ...(col ? { col } : {}) }, autoStart: true }
    }
    case 'new': {
      if (args.length) throw new UsageError(tr('Unknown command: {{cmd}}', { cmd: args.join(' ') }))
      const params = { cwd }
      for (const k of ['agent', 'model', 'effort', 'shell']) if (opts[k] != null) params[k] = opts[k]
      return { method: 'new', params, autoStart: true }
    }
    case 'focus':
      return { method: 'focus', params: {}, autoStart: true }
    case 'status':
      return { method: 'status', params: {}, autoStart: false }
    case 'usage':
      return { method: 'usage', params: {}, autoStart: false }
    case 'task': {
      const sub = args.shift()
      if (sub !== 'add') throw new UsageError(tr('Unknown command: {{cmd}}', { cmd: `task ${sub || ''}`.trim() }))
      const title = args.join(' ').trim()
      if (!title) throw new UsageError(tr('The card needs a title.'))
      return { method: 'task.add', params: { title, cwd, ...(opts.note != null ? { note: opts.note } : {}) }, autoStart: false }
    }
    default: {
      // `tessel .`, `tessel <folder>`, `tessel <file>[:line]`: open it.
      if (!resolveTarget(cmd, cwd, exists).missing) return buildRequest({ cmd: 'open', args: [cmd, ...args], opts }, cwd, exists)
      throw new UsageError(tr('Unknown command: {{cmd}}', { cmd: String(cmd) }))
    }
  }
}

// --- Talking to Tessel --------------------------------------------------------------

export class NotRunning extends Error {}

export function defaultUserData(env = process.env) {
  if (env.TESSEL_CLI_USER_DATA) return env.TESSEL_CLI_USER_DATA
  return join(env.APPDATA || join(env.USERPROFILE || '', 'AppData', 'Roaming'), 'tessel')
}

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return !!(err && err.code === 'EPERM')
  }
}

// -> { pipe, token, pid, locale, … } or null when Tessel is not running.
export function readRuntime(userData, { fsImpl = { readFileSync }, alive = pidAlive } = {}) {
  let runtime
  let token
  try {
    runtime = JSON.parse(fsImpl.readFileSync(join(userData, RUNTIME_FILE), 'utf8'))
    token = fsImpl.readFileSync(join(userData, TOKEN_FILE), 'utf8').trim()
  } catch {
    return null
  }
  if (!runtime || typeof runtime.pipe !== 'string' || !/^\\\\\.\\pipe\\tessel-cli-[0-9a-f]{32}$/.test(runtime.pipe)) return null
  if (!/^[0-9a-f]{64}$/.test(token)) return null
  if (!alive(runtime.pid)) return null
  return { ...runtime, token }
}

export function encodeRequest(token, method, params) {
  const b64 = Buffer.from(JSON.stringify({ token, method, params }), 'utf8').toString('base64')
  const line = `${CLI_PROTOCOL} ${b64}\n`
  if (line.length > MAX_REQUEST_BYTES) throw new UsageError(tr('The request is too long.'))
  return line
}

export function sendRequest(runtime, method, params, { timeoutMs = 60000, netImpl = { createConnection } } = {}) {
  return new Promise((resolve, reject) => {
    const line = encodeRequest(runtime.token, method, params)
    const sock = netImpl.createConnection(runtime.pipe)
    const chunks = []
    let size = 0
    let done = false
    const finish = (err, value) => {
      if (done) return
      done = true
      clearTimeout(timer)
      try {
        sock.destroy()
      } catch {
        /* closed */
      }
      if (err) reject(err)
      else resolve(value)
    }
    const timer = setTimeout(() => finish(new Error(tr('Tessel did not answer in time.'))), timeoutMs)
    sock.on('connect', () => sock.write(line))
    sock.on('error', (err) => {
      if (err && (err.code === 'ENOENT' || err.code === 'ECONNREFUSED')) finish(new NotRunning(tr('Tessel is not running.')))
      else finish(new Error(tr('Could not reach Tessel: {{error}}', { error: (err && (err.code || err.message)) || '?' })))
    })
    sock.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_REPLY_BYTES + 16) return finish(new Error(tr('Tessel sent an answer the command cannot read.')))
      chunks.push(chunk)
    })
    sock.on('close', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) return finish(new Error(tr('Tessel sent an answer the command cannot read.')))
      try {
        const reply = JSON.parse(text)
        if (!reply || typeof reply.ok !== 'boolean') throw new Error('shape') // i18n-ignore internal
        finish(null, reply)
      } catch {
        finish(new Error(tr('Tessel sent an answer the command cannot read.')))
      }
    })
  })
}

// Starts the installed Tessel (TESSEL_CLI_APP) and waits until its pipe is up.
export async function startTessel(env, userData, { spawnImpl = spawn, wait = (ms) => new Promise((r) => setTimeout(r, ms)), read = readRuntime, timeoutMs = 45000, log = () => {} } = {}) {
  const app = env.TESSEL_CLI_APP
  if (!app) throw new NotRunning(tr('Start Tessel first (the development build is not started by the command).'))
  const childEnv = { ...env }
  for (const k of Object.keys(childEnv)) if (k === 'ELECTRON_RUN_AS_NODE' || k.startsWith('TESSEL_CLI_')) delete childEnv[k]
  log(tr('Starting Tessel…'))
  const child = spawnImpl(app, [], { detached: true, stdio: 'ignore', env: childEnv, windowsHide: false })
  if (child && child.on) child.on('error', () => {})
  if (child && child.unref) child.unref()
  const until = Date.now() + timeoutMs
  while (Date.now() < until) {
    await wait(400)
    const runtime = read(userData)
    if (runtime) return runtime
  }
  throw new NotRunning(tr('Tessel did not start in time.'))
}

// --- Output ------------------------------------------------------------------------

function kindWord(kind) {
  return tr(kind === 'agent' ? 'agent' : kind === 'editor' ? 'editor' : 'terminal')
}

export function formatStatus(result) {
  const projects = (result && Array.isArray(result.projects) && result.projects) || []
  if (!projects.length) return tr('No project is open.')
  const panes = projects.reduce((n, p) => n + ((p.panes && p.panes.length) || 0), 0)
  const lines = [`Tessel ${result.version || ''} · ${tr('{{count}} projects, {{panes}} panes', { count: projects.length, panes })}`.trim()]
  for (const p of projects) {
    lines.push(`${p.active ? '*' : ' '} ${p.name}${p.path ? `  ${p.path}` : ''}`)
    for (const pane of p.panes || []) {
      const num = pane.num ? `#${pane.num}` : '  '
      const state = pane.kind === 'agent' && pane.state ? `  [${pane.state}]` : ''
      const active = pane.active ? `  (${tr('active')})` : ''
      lines.push(`    ${num.padEnd(4)} ${kindWord(pane.kind).padEnd(9)} ${pane.title || ''}${state}${active}`)
    }
  }
  return lines.join('\n')
}

export function formatUsage(result) {
  const agents = (result && Array.isArray(result.agents) && result.agents) || []
  if (!agents.length) return tr('No usage information.')
  const lines = []
  for (const a of agents) {
    const windows = Array.isArray(a.windows) ? a.windows : []
    if (!windows.length) {
      lines.push(`${a.id}: ${a.error || tr('not available')}`)
      continue
    }
    lines.push(`${a.id}:`)
    for (const w of windows) {
      const pct = typeof w.usedPct === 'number' ? `${Math.round(w.usedPct)}%` : '?'
      const reset = w.resetsAt ? `  ${tr('resets {{when}}', { when: new Date(w.resetsAt).toLocaleString(locale === 'fr' ? 'fr-CA' : 'en-US') })}` : ''
      lines.push(`  ${String(w.label || '').padEnd(14)} ${pct.padStart(4)}${reset}${w.stale ? ' *' : ''}`)
    }
  }
  return lines.join('\n')
}

export function formatResult(method, result) {
  const r = result || {}
  switch (method) {
    case 'open':
      return r.kind === 'file' ? tr('Opened {{file}} in the editor.', { file: r.file || '' }) : tr('Opened the project {{name}}.', { name: r.project || '' })
    case 'new':
      return tr('Opened a new pane in {{name}}: {{pane}}.', { name: r.project || '', pane: r.pane || '' })
    case 'task.add':
      return tr('Added the card “{{title}}” to the task board of {{name}}.', { title: r.title || '', name: r.project || '' })
    case 'focus':
      return tr('Tessel is in front.')
    case 'status':
      return formatStatus(r)
    case 'usage':
      return formatUsage(r)
    default:
      return JSON.stringify(r)
  }
}

// --- Main ---------------------------------------------------------------------------

// -> exit code. deps for tests: { env, cwd, out, err, read, send, start, exists }.
export async function run(argv, deps = {}) {
  const env = deps.env || process.env
  const out = deps.out || ((s) => process.stdout.write(`${s}\n`))
  const err = deps.err || ((s) => process.stderr.write(`${s}\n`))
  const cwd = deps.cwd || process.cwd()
  const read = deps.read || readRuntime
  const send = deps.send || sendRequest
  const start = deps.start || startTessel
  const name = env.TESSEL_CLI_NAME || 'tessel'
  const userData = defaultUserData(env)
  let runtime = read(userData)
  setLocale((runtime && runtime.locale) || env.TESSEL_CLI_LANG || safeIntlLocale())

  let parsed
  try {
    parsed = parseArgs(argv)
  } catch (e) {
    err(e.message)
    err(helpText(name))
    return EXIT.usage
  }
  if (parsed.opts.version) {
    out(runtime && runtime.appVersion ? `Tessel ${runtime.appVersion}` : 'Tessel')
    return EXIT.ok
  }
  if (parsed.opts.help || !parsed.cmd || parsed.cmd === 'help') {
    out(helpText(name))
    return EXIT.ok
  }
  let req
  try {
    req = buildRequest(parsed, cwd, deps.exists)
  } catch (e) {
    err(e.message)
    return EXIT.usage
  }
  const autoStart = parsed.opts.start != null ? parsed.opts.start : req.autoStart
  try {
    if (!runtime) {
      if (!autoStart) throw new NotRunning(`${tr('Tessel is not running.')} ${tr('Start Tessel, or run the command again with --start.')}`)
      runtime = await start(env, userData, { log: err })
    }
    let reply
    try {
      reply = await send(runtime, req.method, req.params)
    } catch (e) {
      // The pipe was gone (Tessel just closed): start it when allowed.
      if (!(e instanceof NotRunning) || !autoStart) throw e
      runtime = await start(env, userData, { log: err })
      reply = await send(runtime, req.method, req.params)
    }
    if (!reply.ok) {
      const code = reply.error && reply.error.code
      err(code === 'unauthorized' ? tr('The tessel command is not registered correctly: register it again in Tessel (Settings > General > Tessel CLI).') : (reply.error && reply.error.message) || '?')
      return code === 'invalid_argument' ? EXIT.usage : EXIT.failed
    }
    out(parsed.opts.json ? JSON.stringify(reply.result, null, 2) : formatResult(req.method, reply.result))
    return EXIT.ok
  } catch (e) {
    if (e instanceof NotRunning) {
      err(e.message)
      return EXIT.notRunning
    }
    err((e && e.message) || String(e))
    return EXIT.failed
  }
}

function safeIntlLocale() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale
  } catch {
    return 'en'
  }
}
