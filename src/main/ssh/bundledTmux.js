// Tessel's own tmux for SSH hosts that have none (ssh/remoteTmux.js puts it
// in ~/.tessel-server/bin there): static Linux binaries shipped beside the
// app, built by .github/workflows/tmux-static.yml from the official tmux
// release and copied into resources/tmux before a release build:
//   resources/tmux/VERSION            the tmux version ("3.5a")
//   resources/tmux/SHA256SUMS         "<sha256 hex>  linux-x64/tmux" per binary
//   resources/tmux/linux-x64/tmux     x86_64
//   resources/tmux/linux-arm64/tmux   aarch64
//   resources/tmux/LICENSE            tmux's ISC licence (THIRD_PARTY_NOTICES.md)
// A packaged app finds them in process.resourcesPath/tmux (package.json
// extraResources), a checkout in <app>/resources/tmux. A checkout without
// them (the usual one: the binaries are not in git) has no bundle, and a host
// without tmux is told so as before.
import fs from 'fs'
import crypto from 'crypto'
import { join } from 'path'

export const TMUX_ARCHES = ['linux-x64', 'linux-arm64']
const VERSION_RE = /^[0-9A-Za-z.-]{1,40}$/
const SUM_RE = /^([0-9a-f]{64})\s+\*?(linux-(?:x64|arm64))\/tmux\s*$/
// A static binary is about 1.5 MB; anything far larger is not ours.
const MAX_BINARY_BYTES = 16 * 1024 * 1024

// `uname -m` on the host -> the bundle's folder for it, or null (no copy for
// that kind of machine: macOS, BSD, 32-bit, MIPS...).
export function tmuxArchFor(unameM) {
  switch (String(unameM || '').trim()) {
    case 'x86_64':
    case 'amd64':
      return 'linux-x64'
    case 'aarch64':
    case 'arm64':
      return 'linux-arm64'
    default:
      return null
  }
}

// Where the bundle is for this run.
export function bundledTmuxDir({ packaged, resourcesPath, appPath }) {
  return packaged ? join(String(resourcesPath || ''), 'tmux') : join(String(appPath || ''), 'resources', 'tmux')
}

// Reads VERSION and SHA256SUMS once. -> { version, dir, arches, file(arch),
// sha256(arch), read(arch) } for the binaries that are both listed and
// present, or null when the folder, VERSION or SHA256SUMS is missing or
// unreadable, or no listed binary is there. read(arch) gives the binary's
// bytes after checking them against SHA256SUMS (null when they differ: a
// corrupt copy is never sent to a host).
export function loadBundledTmux(dir, { log = () => {} } = {}) {
  if (typeof dir !== 'string' || !dir) return null
  let version
  let sums
  try {
    version = fs.readFileSync(join(dir, 'VERSION'), 'utf8').trim()
    sums = fs.readFileSync(join(dir, 'SHA256SUMS'), 'utf8')
  } catch {
    return null
  }
  if (!VERSION_RE.test(version)) {
    log(`bundled tmux: ${join(dir, 'VERSION')} is not a version`)
    return null
  }
  const files = new Map() // arch -> { path, sha256 }
  for (const line of sums.split(/\r?\n/)) {
    const m = SUM_RE.exec(line)
    if (!m) continue
    const path = join(dir, m[2], 'tmux')
    let st
    try {
      st = fs.statSync(path)
    } catch {
      continue
    }
    if (!st.isFile() || st.size === 0 || st.size > MAX_BINARY_BYTES) {
      log(`bundled tmux: ${path} is not a usable file`)
      continue
    }
    files.set(m[2], { path, sha256: m[1] })
  }
  if (!files.size) return null
  return {
    version,
    dir,
    arches: [...files.keys()],
    file: (arch) => (files.has(arch) ? files.get(arch).path : null),
    sha256: (arch) => (files.has(arch) ? files.get(arch).sha256 : null),
    read(arch) {
      const entry = files.get(arch)
      if (!entry) return null
      let bytes
      try {
        bytes = fs.readFileSync(entry.path)
      } catch {
        return null
      }
      if (crypto.createHash('sha256').update(bytes).digest('hex') !== entry.sha256) {
        log(`bundled tmux: ${entry.path} does not match SHA256SUMS`)
        return null
      }
      return bytes
    }
  }
}
