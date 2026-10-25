// Agents on an SSH host (src/main/remoteAgent/REMOTE_AGENTS.md): what main prepares for a
// remote agent pane. The shim (tessel-shim.cjs) is put on the host once per
// host and app run through the Files session (remoteShell.js __t_ragent),
// which also has it register the team tools and hooks there; the pane then
// gets the token and local environment the terminal host's tunnel needs to
// run the normal server.cjs on this computer for it.
import crypto from 'crypto'
import { join } from 'path'

export const REMOTE_AGENT_PROVIDERS = ['claude', 'codex']
export const INSTALL_TIMEOUT_MS = 60_000

// The shim's version, read from its source (`const VERSION = '…'`). -> string | null
export function shimVersion(source) {
  const m = /^const VERSION = '([0-9A-Za-z.-]{1,40})'/m.exec(String(source || ''))
  return m ? m[1] : null
}

// Where a remote project's .tessel data (team channel, board) lives on this
// computer: one folder per host and remote path; a pane on the host outside
// any project gets the host's own folder (_host).
export function remoteProjectDataDir(userData, hostId, remotePath) {
  const host = join(userData, 'remote-projects', String(hostId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60))
  if (!remotePath) return join(host, '_host')
  return join(host, crypto.createHash('sha1').update(`${hostId}\n${remotePath}`).digest('hex').slice(0, 16))
}

// The socket name on the host: stable per app install and host (survives a
// reconnect), distinct for the dev build, the installed app and another
// computer using the same account there (installId: random, kept by main).
export function instanceName(flavour, hostId, installId = '') {
  const f = String(flavour || 'tessel').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'tessel'
  return `${f}-${crypto.createHash('sha1').update(`${installId}\n${hostId}`).digest('hex').slice(0, 12)}`
}

// This install's id (for instanceName): read from its file, made once. -> 16 hex
export function readInstallId(file, fsApi) {
  try {
    const v = String(fsApi.readFileSync(file, 'utf8')).trim()
    if (/^[0-9a-f]{16}$/.test(v)) return v
  } catch {
    /* none yet */
  }
  const id = crypto.randomBytes(8).toString('hex')
  try {
    fsApi.writeFileSync(file, id + '\n')
  } catch {
    /* kept for this run only */
  }
  return id
}

// The environment of server.cjs run for a remote pane: only what node and
// the team tools need, never the rest of this computer's environment (API
// keys, tokens), since the remote side drives that process.
const KEEP_ENV = new Set(['PATH', 'PATHEXT', 'SYSTEMROOT', 'SYSTEMDRIVE', 'WINDIR', 'COMSPEC', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'HOME', 'LANG'])
export function remoteServerEnv(base, tessel) {
  const env = {}
  for (const [k, v] of Object.entries(base || {})) if (KEEP_ENV.has(k.toUpperCase()) && typeof v === 'string') env[k] = v
  for (const [k, v] of Object.entries(tessel || {})) if (typeof v === 'string' && v) env[k] = v
  return env
}

export const newRemoteToken = () => crypto.randomBytes(32).toString('hex')

// What `node tessel-shim.cjs install` printed (its one JSON line, the last
// one that parses). -> object | null
export function parseInstallOutput(text) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const v = JSON.parse(lines[i])
      if (v && typeof v === 'object') return v
    } catch {
      /* not that one */
    }
  }
  return null
}

// Install codes of __t_ragent (remoteShell.js) -> reason key.
export function installFailure(rc) {
  if (rc === 81) return 'no-node'
  if (rc === 82) return 'old-node'
  if (rc === 124) return 'timeout'
  return 'failed'
}

// Puts the shim on each host once per app run (and again after a failure).
// install(hostId, { version, source }) -> { rc, out, err } | { error }
export function createShimInstaller({ install, source, log = () => {} }) {
  const version = shimVersion(source)
  const done = new Map() // hostId -> Promise<{ ok, result? , reason?, detail? }>
  function ensure(hostId) {
    if (!version) return Promise.resolve({ ok: false, reason: 'failed', detail: 'no shim version' })
    let p = done.get(hostId)
    if (p) return p
    p = Promise.resolve()
      .then(() => install(hostId, { version, source }))
      .then((res) => {
        if (!res || res.error) return { ok: false, reason: 'failed', detail: (res && res.error) || '' }
        // The shim's install exits 1 when one agent's config could not be
        // written: still installed for the others (its JSON line says which).
        const result = parseInstallOutput(res.out)
        if (res.rc !== 0 && !(res.rc === 1 && result)) return { ok: false, reason: installFailure(res.rc), detail: String(res.err || '').slice(0, 500) }
        return { ok: true, result }
      })
      .catch((err) => ({ ok: false, reason: 'failed', detail: (err && err.message) || '' }))
      .then((r) => {
        if (!r.ok) {
          done.delete(hostId)
          log(`remote agent shim on ${hostId}: ${r.reason} ${r.detail || ''}`.trim())
        }
        return r
      })
    done.set(hostId, p)
    return p
  }
  return { ensure, version, forget: (hostId) => done.delete(hostId) }
}

// What __t_agents (remoteShell.js) printed: one line per command looked
// for, `<name> <abs path>|-` (claude, codex, agy...), `vscode-claude …`, then
// what an install there needs, one `@<key> <value>` line each, and
// `@partial login npm` when the login shell or npm ran out of time (what was
// not found may be in a folder they would have named: partial).
// -> { claude, codex, vscodeClaude, bins: { name: path | null },
//      host: { node, nodeMajor, npm, npmPrefix, npmWritable, snap, curl, wget, os }, uid, partial }
// (null when missing or not said)
const AGENT_TOOL_KEYS = { claude: 'claude', codex: 'codex', 'vscode-claude': 'vscodeClaude' }
export const BIN_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,63}$/
const HOST_PATHS = { '@node': 'node', '@npm': 'npm', '@prefix': 'npmPrefix', '@snap': 'snap', '@curl': 'curl', '@wget': 'wget' }
const absPath = (v) => (v.startsWith('/') && v.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null)
const own = (o, k) => Object.prototype.hasOwnProperty.call(o, k)
// codexVersion / codexNoDaemon: the Codex found there (its --version, and
// whether its --help has --no-daemon: Codex 0.156+), null when not found or
// it did not answer in time.
export function emptyHost() {
  return { node: null, nodeMajor: null, npm: null, npmPrefix: null, npmWritable: null, snap: null, curl: null, wget: null, os: null, codexVersion: null, codexNoDaemon: null }
}
export function parseAgentTools(text) {
  const out = { claude: null, codex: null, vscodeClaude: null, bins: {}, host: emptyHost(), uid: null, partial: false }
  for (const line of String(text || '').split('\n')) {
    const sp = line.indexOf(' ')
    if (sp < 0) continue
    const name = line.slice(0, sp)
    const value = line.slice(sp + 1).replace(/\r$/, '')
    if (name.startsWith('@')) {
      const key = HOST_PATHS[name]
      if (key) {
        if (!out.host[key]) out.host[key] = absPath(value)
      } else if (name === '@nodev') {
        const m = /^(\d{1,3})\.\d/.exec(value)
        if (m && out.host.nodeMajor == null) out.host.nodeMajor = Number(m[1])
      } else if (name === '@prefixw') {
        if (value === '1' || value === '0') out.host.npmWritable = value === '1'
      } else if (name === '@uid') {
        if (/^\d{1,10}$/.test(value)) out.uid = Number(value)
      } else if (name === '@os') {
        if (/^[A-Za-z][\w.-]{0,31}$/.test(value)) out.host.os = value
      } else if (name === '@partial') {
        out.partial = true
      } else if (name === '@codexv') {
        if (/^\d{1,4}\.\d{1,4}(?:\.\d{1,6})?(?:[-+.][0-9A-Za-z.]{1,40})?$/.test(value) && out.host.codexVersion == null) out.host.codexVersion = value
      } else if (name === '@codexnd') {
        if ((value === '1' || value === '0') && out.host.codexNoDaemon == null) out.host.codexNoDaemon = value === '1'
      }
      continue
    }
    const path = absPath(value)
    const key = AGENT_TOOL_KEYS[name]
    if (key && !out[key] && path) out[key] = path
    if (name === 'vscode-claude' || !BIN_NAME.test(name)) continue
    if (!own(out.bins, name) || (!out.bins[name] && path)) out.bins[name] = path
  }
  return out
}

// The check made when a terminal opens on a host (like VS Code's server):
// the shim put there (ensureShim: createShimInstaller().ensure) and the
// agents found there (agentTools: remoteFs.agentTools, looking for each
// agent's command, agentBins: [{ id, bin }]). Once per host and app run, in
// the background; again at the next terminal when the host could not be
// reached. send(status) tells the window:
//   { hostId, label, claude, codex, vscodeClaude, agents: { id: path | null },
//     host: { node, npm... }, uid?, partial?, shim: 'ok' | reason, error? }
// partial: the login shell or npm ran out of time there, so an agent not
// found may still be there (the window takes it as unknown, not missing).
// A pane whose ssh still signs in (system ssh with askpass) waits for its
// sign-in (paneConnected), so the user is never asked twice at once.
// The window may ask again (check): a check younger than ttlMs, or one
// already running, answers it (several panes starting at once ask the host
// once); fresh (Check again, after an install) always asks the host.
export const AGENT_CHECK_TTL_MS = 10_000
export function createRemoteAgentCheck({ ensureShim, agentTools, agentBins = [], label = (id) => id, send = () => {}, log = () => {}, now = Date.now, ttlMs = AGENT_CHECK_TTL_MS }) {
  const done = new Map() // hostId -> Promise<status>
  const waiting = new Map() // paneId -> hostId
  const latest = new Map() // hostId -> { at, status } (the last check that reached the host)
  const running = new Map() // hostId -> Promise<status>
  const freshRunning = new Map() // hostId -> Promise<status> (a `fresh` check)
  const bins = (Array.isArray(agentBins) ? agentBins : []).filter((b) => b && typeof b.id === 'string' && typeof b.bin === 'string' && BIN_NAME.test(b.bin))
  // Each agent by its command: its path there, null when missing; not
  // reported (an older shell): left out (not checked).
  function agentsOf(found) {
    const agents = {}
    const reported = found && found.bins && typeof found.bins === 'object' ? found.bins : {}
    for (const { id, bin } of bins) if (own(reported, bin)) agents[id] = reported[bin] || null
    return agents
  }
  // Whether the host's Codex knows --no-daemon, kept per host for its path and
  // version: a later check whose Codex did not answer in time (the same path
  // and version) still says it; another path or version is asked anew.
  const codexDaemon = new Map() // hostId -> { path, version, noDaemon }
  function keepCodexDaemon(hostId, status) {
    const host = status.host
    if (!host || !status.codex) return
    if (typeof host.codexNoDaemon === 'boolean') {
      codexDaemon.set(hostId, { path: status.codex, version: host.codexVersion, noDaemon: host.codexNoDaemon })
      return
    }
    const kept = codexDaemon.get(hostId)
    if (kept && kept.path === status.codex && kept.version && kept.version === host.codexVersion) host.codexNoDaemon = kept.noDaemon
  }
  // The shim and the agents are asked at once: neither needs the other (on
  // the host's pane lane they follow each other with no gap; a pane opening
  // waits for both).
  async function run(hostId) {
    const [shim, tools] = await Promise.all([
      Promise.resolve()
        .then(() => ensureShim(hostId))
        .catch((err) => ({ ok: false, reason: 'failed', detail: (err && err.message) || '' })),
      Promise.resolve()
        .then(() => agentTools(hostId))
        .catch((err) => ({ error: (err && err.message) || 'failed' }))
    ])
    const ok = tools && !tools.error
    const found = ok ? tools : { claude: null, codex: null, vscodeClaude: null }
    const status = {
      hostId,
      label: String(label(hostId) || hostId),
      claude: found.claude || null,
      codex: found.codex || null,
      vscodeClaude: found.vscodeClaude || null,
      ...(ok ? { agents: agentsOf(found), host: { ...emptyHost(), ...(found.host || {}) } } : {}),
      ...(ok && Number.isInteger(found.uid) ? { uid: found.uid } : {}),
      ...(ok && found.partial === true ? { partial: true } : {}),
      shim: shim && shim.ok ? 'ok' : (shim && shim.reason) || 'failed',
      ...(tools && tools.error ? { error: String(tools.error).slice(0, 500) } : {})
    }
    keepCodexDaemon(hostId, status)
    if (status.error) log(`remote agent check on ${hostId}: ${status.error}`)
    else if (status.partial) log(`remote agent check on ${hostId}: the login shell or npm ran out of time; agents not found there are unknown`)
    // Neither a failure nor a partial answer is given again: the next asks the host.
    else latest.set(hostId, { at: now(), status })
    return status
  }
  // One check of the host at a time; a newer one replaces the older answer.
  function ask(hostId) {
    const p = run(hostId).finally(() => {
      if (running.get(hostId) === p) running.delete(hostId)
    })
    running.set(hostId, p)
    return p
  }
  // A terminal on the host started (connected). -> Promise<status>
  function hostStarted(hostId) {
    if (typeof hostId !== 'string' || !hostId) return Promise.resolve(null)
    let p = done.get(hostId)
    if (p) return p
    // A check already running (asked for a pane while it opened): that one.
    p = (running.get(hostId) || ask(hostId)).then((status) => {
      // Not reached, or only partly (too slow): the next terminal there tries again.
      if ((status.error || status.partial) && done.get(hostId) === p) done.delete(hostId)
      try {
        send(status)
      } catch {
        /* the window is gone */
      }
      return status
    })
    done.set(hostId, p)
    return p
  }
  return {
    hostStarted,
    // Once that pane's ssh is signed in.
    waitConnected(paneId, hostId) {
      if (typeof hostId === 'string' && hostId) waiting.set(paneId, hostId)
    },
    paneConnected(paneId) {
      const hostId = waiting.get(paneId)
      if (!hostId) return
      waiting.delete(paneId)
      void hostStarted(hostId)
    },
    paneExited(paneId) {
      waiting.delete(paneId)
    },
    // The window asks again (a pane starting an agent missing in the last
    // check, Check again, after installing one): answered, not sent.
    check(hostId, { fresh = false } = {}) {
      if (!fresh) {
        const last = latest.get(hostId)
        if (last && now() - last.at < ttlMs) return Promise.resolve(last.status)
        const busy = running.get(hostId)
        if (busy) return busy
      }
      if (!fresh) return ask(hostId)
      // Repeated "Check again" clicks share the fresh check already running:
      // they cannot stack first-priority requests in the host's queue.
      const again = freshRunning.get(hostId)
      if (again) return again
      const p = ask(hostId).finally(() => {
        if (freshRunning.get(hostId) === p) freshRunning.delete(hostId)
      })
      freshRunning.set(hostId, p)
      return p
    }
  }
}

// The agent sessions on a host: what `tessel-shim.cjs sessions <limit>`
// printed (one JSON line {"v":1,"sessions":[...]}, the last that parses),
// each row checked; the host added. -> rows | null (nothing readable)
export const REMOTE_SESSIONS_DEFAULT = 60
export const REMOTE_SESSIONS_MAX = 200
export function remoteSessionsLimit(raw) {
  const n = Number(raw)
  return Number.isInteger(n) && n >= 1 && n <= REMOTE_SESSIONS_MAX ? n : REMOTE_SESSIONS_DEFAULT
}
const SESSION_ID_RE = /^[0-9a-zA-Z-]{1,80}$/
const CONTROL_RE = /[\u0000-\u001f\u007f]/
export function parseRemoteSessions(text, hostId, limit = REMOTE_SESSIONS_MAX) {
  const lines = String(text || '').split('\n').map((l) => l.trim()).filter(Boolean)
  let doc = null
  for (let i = lines.length - 1; i >= 0 && !doc; i--) {
    try {
      const v = JSON.parse(lines[i])
      if (v && typeof v === 'object' && v.v === 1 && Array.isArray(v.sessions)) doc = v
    } catch {
      /* not that one */
    }
  }
  if (!doc) return null
  const rows = []
  const perAgent = { claude: 0, codex: 0 }
  for (const r of doc.sessions) {
    if (!r || typeof r !== 'object') continue
    if (r.agent !== 'claude' && r.agent !== 'codex') continue
    if (typeof r.id !== 'string' || !SESSION_ID_RE.test(r.id)) continue
    if (typeof r.cwd !== 'string' || !r.cwd.startsWith('/') || r.cwd.length > 4096 || CONTROL_RE.test(r.cwd)) continue
    if (perAgent[r.agent] >= limit) continue
    perAgent[r.agent]++
    const started = typeof r.started === 'string' && r.started.length <= 40 && !Number.isNaN(Date.parse(r.started)) ? r.started : null
    const updated = typeof r.updated === 'number' && Number.isFinite(r.updated) && r.updated >= 0 ? r.updated : null
    const title = typeof r.title === 'string' ? r.title.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200) : ''
    rows.push({ agent: r.agent, id: r.id, cwd: r.cwd, started, updated, title, host: hostId })
  }
  return rows
}
