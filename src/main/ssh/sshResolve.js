// A saved remote host -> the connection spec for the ssh2 client (terminal
// host, sshHostBridge.js). Like Orca's ssh-g-config-resolution.ts (MIT,
// Copyright (c) 2026 Lovecast Inc.), the effective settings come from
// `ssh -G <the same argv a terminal used>`: OpenSSH itself resolves
// ~/.ssh/config (Host / Match blocks, Include, first value wins), so Tessel
// connects with exactly what ssh would use: HostName, User, Port,
// IdentityFile, IdentitiesOnly, IdentityAgent, StrictHostKeyChecking,
// UserKnownHostsFile / GlobalKnownHostsFile, HostKeyAlias. `ssh -G` only
// prints the configuration; it never connects.
//
// Hosts that need what the ssh2 client does not do keep the system ssh
// (ssh.exe in the terminal, askpass dialog): ProxyJump, ProxyCommand,
// PKCS#11, certificates, GSSAPI/Kerberos. Without ssh.exe (or when -G fails)
// the saved fields and OpenSSH's defaults are used.
import fs from 'fs'
import os from 'os'
import { win32 } from 'path'
import { execFile } from 'child_process'
import { sshArgsFor } from '../remoteHosts'
import { resolveSshConfigHomePath } from '../sshConfig'
import { defaultIdentityFiles } from './sshPaths'
import { defaultKnownHostsFiles } from './knownHosts'

const G_TIMEOUT_MS = 8000
const CACHE_MS = 15_000
const MAX_OUTPUT = 256 * 1024

// `ssh -G` output -> Map<key, string[]> (keys lower-cased, values in order).
export function parseSshG(text) {
  const out = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const m = /^(\S+)\s+(.*)$/.exec(line.trim())
    if (!m) continue
    const key = m[1].toLowerCase()
    if (!out.has(key)) out.set(key, [])
    out.get(key).push(m[2].trim())
  }
  return out
}

// MSYS ssh prints /c/Users/...; Windows OpenSSH prints C:\Users\me/.ssh/x.
function nativePath(p, home) {
  let s = resolveSshConfigHomePath(String(p || ''), home)
  if (process.platform === 'win32' && /^\/[a-zA-Z]\//.test(s)) s = `${s[1].toUpperCase()}:\\${s.slice(3)}`
  return process.platform === 'win32' ? win32.normalize(s) : s
}

// A list value whose paths may contain spaces (ssh -G prints them unquoted):
// the longest run of words that names an existing file is one path.
export function splitPathList(value, { home = os.homedir(), exists = fs.existsSync } = {}) {
  const words = String(value || '').split(/\s+/).filter(Boolean)
  const out = []
  let i = 0
  while (i < words.length) {
    let taken = 0
    for (let end = words.length; end > i + 1; end--) {
      const candidate = nativePath(words.slice(i, end).join(' '), home)
      let ok = false
      try {
        ok = exists(candidate)
      } catch {
        ok = false
      }
      if (ok) {
        out.push(candidate)
        taken = end - i
        break
      }
    }
    if (!taken) {
      out.push(nativePath(words[i], home))
      taken = 1
    }
    i += taken
  }
  return out.filter((p) => p && p.toLowerCase() !== 'none')
}

const isSet = (v) => v !== undefined && v !== null && v !== '' && String(v).toLowerCase() !== 'none'

// -> { ok: true, spec } | { ok: false, system: true, reason }
export function specFromSshG(map, target, { home = os.homedir(), exists = fs.existsSync, username = safeUser() } = {}) {
  const one = (k) => (map.get(k) || [])[0]
  if (isSet(one('proxyjump'))) return { ok: false, system: true, reason: 'proxyjump' }
  if (isSet(one('proxycommand'))) return { ok: false, system: true, reason: 'proxycommand' }
  if (isSet(one('pkcs11provider'))) return { ok: false, system: true, reason: 'pkcs11' }
  if ((map.get('certificatefile') || []).some(isSet)) return { ok: false, system: true, reason: 'certificate' }
  if (String(one('gssapiauthentication') || '').toLowerCase() === 'yes') return { ok: false, system: true, reason: 'gssapi' }
  const port = Number(one('port') || target.port || 22)
  const known = [
    ...splitPathList((map.get('userknownhostsfile') || []).join(' '), { home, exists }),
    ...splitPathList((map.get('globalknownhostsfile') || []).join(' '), { home, exists })
  ]
  return {
    ok: true,
    spec: {
      host: one('hostname') || target.host,
      port: Number.isInteger(port) ? port : 22,
      username: one('user') || target.username || username,
      identityFiles: (map.get('identityfile') || []).filter(isSet).map((p) => nativePath(p, home)),
      identitiesOnly: String(one('identitiesonly') || '').toLowerCase() === 'yes',
      identityAgent: one('identityagent') || null,
      strictHostKeyChecking: one('stricthostkeychecking') || 'ask',
      knownHostsFiles: known.length ? known : defaultKnownHostsFiles(home),
      hostKeyAlias: isSet(one('hostkeyalias')) ? one('hostkeyalias') : null
    }
  }
}

function safeUser() {
  try {
    return os.userInfo().username
  } catch {
    return ''
  }
}

// Without ssh.exe: the saved fields and OpenSSH's defaults.
export function specFromTarget(target, { home = os.homedir(), username = safeUser() } = {}) {
  if (target.jumpHost) return { ok: false, system: true, reason: 'proxyjump' }
  if (target.proxyCommand) return { ok: false, system: true, reason: 'proxycommand' }
  return {
    ok: true,
    spec: {
      host: target.host,
      port: target.port || 22,
      username: target.username || username,
      identityFiles: target.identityFile ? [nativePath(target.identityFile, home)] : defaultIdentityFiles(home),
      identitiesOnly: false,
      identityAgent: null,
      strictHostKeyChecking: 'ask',
      knownHostsFiles: defaultKnownHostsFiles(home),
      hostKeyAlias: null
    }
  }
}

export function createSshResolver({ sshExe = () => null, runFile = execFile, home = os.homedir(), now = () => Date.now() } = {}) {
  const cache = new Map()

  function runG(exe, args) {
    return new Promise((resolve) => {
      try {
        runFile(exe, ['-G', ...args], { timeout: G_TIMEOUT_MS, windowsHide: true, shell: false, maxBuffer: MAX_OUTPUT }, (err, stdout) => {
          resolve(err ? null : String(stdout || ''))
        })
      } catch {
        resolve(null)
      }
    })
  }

  // target: remoteHosts.js's saved host. -> { ok, spec } | { ok: false, system, reason }
  async function resolve(target) {
    const key = JSON.stringify(target)
    const hit = cache.get(key)
    if (hit && now() - hit.at < CACHE_MS) return hit.value
    let value
    const exe = sshExe()
    let args = null
    try {
      args = sshArgsFor(target)
    } catch {
      return { ok: false, system: true, reason: 'invalid' }
    }
    const out = exe ? await runG(exe, args) : null
    const map = out ? parseSshG(out) : null
    if (map && map.get('hostname')) value = specFromSshG(map, target, { home })
    else value = specFromTarget(target, { home })
    cache.set(key, { at: now(), value })
    if (cache.size > 200) cache.delete(cache.keys().next().value)
    return value
  }

  return { resolve, clear: () => cache.clear() }
}

