// Where an SSH sign-in's keys come from, like Orca's ssh-auth-resolution.ts
// and ssh-agent-identity-filter.ts (MIT, Copyright (c) 2026 Lovecast Inc.):
// - the agent: the spec's IdentityAgent, else SSH_AUTH_SOCK, else Windows'
//   OpenSSH agent pipe; with IdentitiesOnly, only the agent keys that match
//   an IdentityFile are offered;
// - the IdentityFile keys (ssh -G lists the configured ones, or OpenSSH's
//   defaults): read here, parsed with ssh2; an encrypted one is marked so the
//   sign-in asks its passphrase (and only when the server takes keys).
// Key contents stay in this process's memory for the attempt; never logged.
import fs from 'fs'
import os from 'os'
import ssh2 from 'ssh2'
import { expandHome } from './sshPaths'

const { utils, BaseAgent, createAgent } = ssh2

export const WINDOWS_OPENSSH_AGENT_PIPE = '\\\\.\\pipe\\openssh-ssh-agent'
const MAX_KEY_BYTES = 64 * 1024
const MAX_KEYS = 16

export function isPassphraseError(err) {
  const msg = String((err && err.message) || '').toLowerCase()
  return msg.includes('passphrase') || msg.includes('encrypted key') || msg.includes('bad decrypt')
}

function firstKey(parsed) {
  return Array.isArray(parsed) ? parsed[0] : parsed
}

// The key files that exist -> [{ path, contents, encrypted }]. A file that is
// not a private key ssh2 can use (a security key, a public key, garbage) is
// left out.
export function loadIdentityKeys(paths, { fsApi = fs, home = os.homedir() } = {}) {
  const out = []
  const seen = new Set()
  for (const raw of paths || []) {
    if (out.length >= MAX_KEYS) break
    const path = expandHome(raw, home)
    const k = path.toLowerCase()
    if (!path || seen.has(k)) continue
    seen.add(k)
    let contents
    try {
      const st = fsApi.statSync(path)
      if (!st.isFile() || st.size === 0 || st.size > MAX_KEY_BYTES) continue
      contents = fsApi.readFileSync(path)
    } catch {
      continue
    }
    let parsed
    try {
      parsed = utils.parseKey(contents)
    } catch (err) {
      parsed = err instanceof Error ? err : new Error('unreadable key') // i18n-ignore internal
    }
    if (parsed instanceof Error) {
      if (isPassphraseError(parsed)) out.push({ path, contents, encrypted: true })
      continue
    }
    const key = firstKey(parsed)
    if (!key || typeof key.isPrivateKey !== 'function' || !key.isPrivateKey()) continue
    // FIDO security keys (sk-*) need the authenticator: ssh2 cannot sign.
    if (/^sk-/.test(String(key.type || ''))) continue
    out.push({ path, contents, encrypted: false })
  }
  return out
}

// The agent socket: 'none' -> null; else the configured one, SSH_AUTH_SOCK,
// or the Windows OpenSSH agent pipe.
export function resolveAgentSocket(identityAgent, env = process.env, platform = process.platform) {
  if (identityAgent != null && identityAgent !== '') {
    const v = String(identityAgent).trim()
    if (!v || v.toLowerCase() === 'none') return null
    if (v === 'SSH_AUTH_SOCK') return env.SSH_AUTH_SOCK || null
    if (/\$/.test(v)) {
      let missing = false
      const expanded = v.replace(/\$(\w+)|\$\{([^}]+)\}/g, (_m, a, b) => {
        const val = env[a || b]
        if (val === undefined) missing = true
        return val || ''
      })
      return missing ? null : expandHome(expanded)
    }
    return expandHome(v)
  }
  return env.SSH_AUTH_SOCK || (platform === 'win32' ? WINDOWS_OPENSSH_AGENT_PIPE : null)
}

function publicKeyOf(path, fsApi) {
  for (const p of [`${path}.pub`, path]) {
    try {
      const st = fsApi.statSync(p)
      if (!st.isFile() || st.size > MAX_KEY_BYTES) continue
      const parsed = utils.parseKey(fsApi.readFileSync(p))
      if (!(parsed instanceof Error)) return firstKey(parsed)
    } catch {
      /* next */
    }
  }
  return null
}

function comparable(key) {
  if (key && typeof key === 'object' && 'pubKey' in key) {
    const pk = key.pubKey
    return pk && typeof pk === 'object' && 'pubKey' in pk ? pk.pubKey : pk
  }
  return key
}

// IdentitiesOnly: the agent offers only the keys of the IdentityFile list.
class IdentityFilteredAgent extends BaseAgent {
  constructor(agent, allowed) {
    super()
    this.agent = agent
    this.allowed = allowed
    if (agent.getStream) this.getStream = agent.getStream.bind(agent)
  }
  getIdentities(cb) {
    this.agent.getIdentities((err, keys) => {
      if (err) return cb(err)
      cb(undefined, (keys || []).filter((k) => this.allowed.some((a) => a.equals(comparable(k)))))
    })
  }
  sign(pubKey, data, options, cb) {
    if (typeof options === 'function') return this.agent.sign(pubKey, data, options)
    return this.agent.sign(pubKey, data, options || {}, cb)
  }
}

// -> an ssh2 agent (or path) to offer, or null.
export function agentFor({ identityAgent, identitiesOnly, identityFiles }, { env = process.env, fsApi = fs, home = os.homedir(), create = createAgent } = {}) {
  const sock = resolveAgentSocket(identityAgent, env)
  if (!sock) return null
  if (!identitiesOnly) return create(sock)
  const allowed = (identityFiles || []).map((p) => publicKeyOf(expandHome(p, home), fsApi)).filter(Boolean)
  if (!allowed.length) return null
  return new IdentityFilteredAgent(create(sock), allowed)
}

// A passphrase for an encrypted key: true when it decrypts it.
export function passphraseOpens(contents, passphrase) {
  try {
    const parsed = utils.parseKey(contents, passphrase)
    if (parsed instanceof Error) return false
    const key = firstKey(parsed)
    return !!key && typeof key.isPrivateKey === 'function' && key.isPrivateKey()
  } catch {
    return false
  }
}
