// The tessel-host programs shipped beside the app (one release of tessel-host:
// its manifest.json and the static Linux programs it names), copied into
// resources/host by scripts/host-sync.mjs from the release's assets, their
// checksums checked against the release's SHA256SUMS then and against the
// manifest here before any byte goes to a host:
//   resources/host/manifest.json                            the release (version, artifacts)
//   resources/host/tessel-host-x86_64-unknown-linux-musl    x86_64
//   resources/host/tessel-host-aarch64-unknown-linux-musl   aarch64
//   resources/host/LICENSE                                  tessel-host's licence
// A packaged app finds them in process.resourcesPath/host (package.json
// extraResources), a checkout in <app>/resources/host. Without them, hosts
// keep the shell-based Files path as before.
import fs from 'node:fs'
import { join } from 'node:path'
import { type Arch, type Artifact, type Manifest, artifactFor, matches, parseManifest } from './install'

// A static program is under 2 MB; anything far larger is not ours.
const MAX_PROGRAM_BYTES = 32 * 1024 * 1024

export interface BundledHost {
  version: string
  dir: string
  manifest: Manifest
  artifact(arch: Arch): Artifact | null
  /** The program's bytes after checking them against the manifest (null when they differ or are missing). */
  read(arch: Arch): Buffer | null
}

/** Where the bundle is for this run. */
export function bundledHostDir({ packaged, resourcesPath, appPath }: { packaged: boolean; resourcesPath?: string; appPath?: string }): string {
  return packaged ? join(String(resourcesPath || ''), 'host') : join(String(appPath || ''), 'resources', 'host')
}

/** Reads the manifest once; null when the folder or the manifest is missing or not a release's. */
export function loadBundledHost(dir: string, { log = () => {} }: { log?: (text: string) => void } = {}): BundledHost | null {
  if (typeof dir !== 'string' || !dir) return null
  let text: string
  try {
    text = fs.readFileSync(join(dir, 'manifest.json'), 'utf8')
  } catch {
    return null
  }
  const manifest = parseManifest(text)
  if (!manifest) {
    log(`bundled tessel-host: ${join(dir, 'manifest.json')} is not a release manifest`)
    return null
  }
  const present = manifest.artifacts.filter((a) => {
    try {
      const st = fs.statSync(join(dir, a.file))
      return st.isFile() && st.size === a.size && st.size <= MAX_PROGRAM_BYTES
    } catch {
      return false
    }
  })
  if (!present.length) {
    log(`bundled tessel-host: no program of ${manifest.version} in ${dir}`)
    return null
  }
  const only: Manifest = { version: manifest.version, artifacts: present }
  return {
    version: manifest.version,
    dir,
    manifest: only,
    artifact: (arch) => artifactFor(only, arch),
    read(arch) {
      const artifact = artifactFor(only, arch)
      if (!artifact) return null
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(join(dir, artifact.file))
      } catch {
        return null
      }
      if (!matches(artifact, bytes)) {
        log(`bundled tessel-host: ${join(dir, artifact.file)} does not match the manifest (not sent)`)
        return null
      }
      return bytes
    }
  }
}
