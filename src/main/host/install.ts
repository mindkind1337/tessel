// Putting `tessel-host` on a host, from the client, over the exec channel it
// already has: no downloaded script, no curl, package manager, sudo or Node
// on the host. A port of tessel-host's `tessel_host::install` (crates/host/
// src/install.rs), the only source of the commands run on a host and of the
// program's path: the strings here are the same, byte for byte (the spec
// holds them written out). Each command is a fixed template whose only
// variable parts are a version, an architecture and a nonce, checked to be
// plain tokens first; every path is under `$HOME`, never one a client or a
// host chose.
import { createHash } from 'node:crypto'
import { PROTOCOL_VERSION } from './wire'

export type Arch = 'x86_64' | 'aarch64'

/** From what `uname -m` printed. */
export function archFromUname(output: string): Arch | null {
  switch (output.trim()) {
    case 'x86_64':
    case 'amd64':
      return 'x86_64'
    case 'aarch64':
    case 'arm64':
      return 'aarch64'
    default:
      return null
  }
}

export const archTarget = (arch: Arch): string => `${arch}-unknown-linux-musl`

/** One built program of a release. */
export interface Artifact {
  arch: Arch
  target: string
  file: string
  size: number
  sha256: string
}

/** `manifest.json` of a release. */
export interface Manifest {
  version: string
  artifacts: Artifact[]
}

const token = (value: unknown): value is string => typeof value === 'string' && /^[a-z0-9._-]{1,32}$/.test(value)
const hex64 = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value)
const isArch = (value: unknown): value is Arch => value === 'x86_64' || value === 'aarch64'

/** The manifest, or null when it is not one this client accepts. */
export function parseManifest(text: string): Manifest | null {
  let value: unknown
  try {
    value = JSON.parse(text)
  } catch {
    return null
  }
  const m = value as Record<string, unknown> | null
  if (!m || typeof m !== 'object' || !token(m.version) || !Array.isArray(m.artifacts) || !m.artifacts.length) return null
  const artifacts: Artifact[] = []
  for (const raw of m.artifacts as unknown[]) {
    const a = raw as Record<string, unknown> | null
    if (!a || typeof a !== 'object' || !isArch(a.arch)) return null
    const keys = Object.keys(a).sort().join(',')
    if (keys !== 'arch,file,sha256,size,target') return null
    if (a.target !== archTarget(a.arch) || a.file !== `tessel-host-${a.target}` || !hex64(a.sha256)) return null
    if (typeof a.size !== 'number' || !Number.isSafeInteger(a.size) || a.size <= 0) return null
    if (artifacts.some((b) => b.arch === a.arch)) return null
    artifacts.push({ arch: a.arch, target: a.target, file: a.file, size: a.size, sha256: a.sha256 })
  }
  return { version: m.version, artifacts }
}

export const artifactFor = (manifest: Manifest, arch: Arch): Artifact | null => manifest.artifacts.find((a) => a.arch === arch) ?? null

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex')

/** The program about to be sent is the one the manifest names. */
export const matches = (artifact: Artifact, bytes: Buffer): boolean => bytes.length === artifact.size && sha256Hex(bytes) === artifact.sha256

/**
 * The commands, in order. `upload` reads the program on its standard input;
 * the client compares what `digest` prints with the manifest (`parseDigest`)
 * and runs `activate` only if they are the same, `abort` otherwise.
 * `activate` ends by running the installed program's `version`, which the
 * client checks (`checkVersion`) before connecting. Every field is a complete
 * shell command for the exec channel, to be passed as it is: paths in them
 * use `$HOME` inside double quotes so the host's shell expands it.
 */
export interface Plan {
  probe: string
  upload: string
  digest: string
  activate: string
  abort: string
  /** The installed program's path as a shell expression, for display only. */
  installed: string
  /** Prints the installed program's version line (check it with `checkVersion`). */
  version: string
  /** What the SSH channel of a connection runs. */
  connect: string
}

const DIRS = ['$HOME/.tessel-server', '$HOME/.tessel-server/host', '$HOME/.tessel-server/host/bin'] as const

/** `nonce`: 16 random hexadecimal digits, so two installs never share a temporary file. */
export function plan(version: string, arch: Arch, nonce: string): Plan | null {
  if (!token(version) || !/^[0-9a-f]{16}$/.test(nonce)) return null
  const bin = DIRS[2]
  const installed = `${bin}/tessel-host-${version}-${arch}`
  const part = `${bin}/.tessel-host-${version}-${arch}.${nonce}.part`
  const noLinks = DIRS.map((d) => `[ ! -L "${d}" ]`).join(' && ')
  return {
    probe: 'uname -m',
    upload: `umask 077 && ${noLinks} && mkdir -p "${bin}" && ${noLinks} && cat > "${part}"`,
    digest: `if command -v sha256sum >/dev/null 2>&1; then sha256sum "${part}"; else busybox sha256sum "${part}"; fi`,
    activate: `chmod 700 "${part}" && mv -f "${part}" "${installed}" && "${installed}" version`,
    abort: `rm -f "${part}"`,
    installed,
    version: `"${installed}" version`,
    connect: `"${installed}" connect --stdio`
  }
}

/** The commands to check and reach an installed version without a nonce (no upload planned). */
export function commands(version: string, arch: Arch): { version: string; connect: string } | null {
  const p = plan(version, arch, '0000000000000000')
  return p && { version: p.version, connect: p.connect }
}

/** The digest at the start of `sha256sum`'s output. */
export function parseDigest(output: string): string | null {
  const first = output.split(/\s+/).find((w) => w.length > 0)?.toLowerCase()
  return first && hex64(first) ? first : null
}

/** What the installed program said about itself is what was meant to be installed. */
export function checkVersion(output: string, version: string, arch: Arch): boolean {
  let value: unknown
  try {
    value = JSON.parse(output.trim())
  } catch {
    return false
  }
  const v = value as Record<string, unknown> | null
  return (
    !!v &&
    typeof v === 'object' &&
    v.name === 'tessel-host' &&
    v.version === version &&
    v.arch === arch &&
    Array.isArray(v.protocol) &&
    v.protocol.includes(PROTOCOL_VERSION)
  )
}
