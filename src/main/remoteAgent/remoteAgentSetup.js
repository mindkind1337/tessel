// Agents on an SSH host (design/remote-agents.md): what main prepares for a
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
// computer: one folder per host and remote path.
export function remoteProjectDataDir(userData, hostId, remotePath) {
  const hash = crypto.createHash('sha1').update(`${hostId}\n${remotePath}`).digest('hex').slice(0, 16)
  return join(userData, 'remote-projects', String(hostId).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 60), hash)
}

// The socket name on the host: stable per app build and host (survives a
// reconnect), distinct for the dev build and the installed app.
export function instanceName(flavour, hostId) {
  const f = String(flavour || 'tessel').toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 20) || 'tessel'
  return `${f}-${crypto.createHash('sha1').update(String(hostId)).digest('hex').slice(0, 12)}`
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
