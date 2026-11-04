// resources/host: tessel-host's programs for SSH hosts (src/main/host/
// bundled.ts), copied from a release of mindkind1337/tessel-host by
// scripts/host-sync.mjs. When they are there, manifest.json must be a
// release manifest and each program named in it must be there with the size
// and the SHA-256 it gives; SHA256SUMS (the release's) must agree. A checkout
// without them passes: hosts then keep the shell-based Files path. With
// TESSEL_REQUIRE_HOST=1 (a release build) the manifest, both programs,
// SHA256SUMS and LICENSE must be there. Run by scripts/check-bundle.mjs, or
// alone:
//   node scripts/check-host-resources.mjs [resources/host]
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const ARCHES = ['x86_64', 'aarch64']
const FILE_OF = (arch) => `tessel-host-${arch}-unknown-linux-musl`
const SUM_RE = /^([0-9a-f]{64})\s+\*?(tessel-host-(?:x86_64|aarch64)-unknown-linux-musl)\s*$/

// -> { errors: [string], checked: number, version: string }
export function checkHostResources(dir = path.join('resources', 'host'), { required = process.env.TESSEL_REQUIRE_HOST === '1' } = {}) {
  const errors = []
  const manifestFile = path.join(dir, 'manifest.json')
  const present = ARCHES.filter((a) => fs.existsSync(path.join(dir, FILE_OF(a))))
  if (required) {
    for (const a of ARCHES) if (!present.includes(a)) errors.push(`${path.join(dir, FILE_OF(a))} is missing (TESSEL_REQUIRE_HOST=1: a release ships tessel-host)`)
    for (const f of ['manifest.json', 'SHA256SUMS', 'LICENSE']) if (!fs.existsSync(path.join(dir, f))) errors.push(`${path.join(dir, f)} is missing (TESSEL_REQUIRE_HOST=1)`)
  }
  if (!present.length && !fs.existsSync(manifestFile)) return { errors, checked: 0, version: '' }
  if (!fs.existsSync(manifestFile)) {
    errors.push(`${manifestFile} is missing while ${present.map(FILE_OF).join(', ')} is there`)
    return { errors, checked: 0, version: '' }
  }
  let manifest
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
  } catch {
    errors.push(`${manifestFile} is not JSON`)
    return { errors, checked: 0, version: '' }
  }
  const version = typeof manifest.version === 'string' && /^[a-z0-9._-]{1,32}$/.test(manifest.version) ? manifest.version : ''
  if (!version) errors.push(`${manifestFile} must name the release version (like 0.1.1)`)
  const artifacts = Array.isArray(manifest.artifacts) ? manifest.artifacts : []
  if (!artifacts.length) errors.push(`${manifestFile} names no program`)
  const sums = new Map()
  const sumsFile = path.join(dir, 'SHA256SUMS')
  if (fs.existsSync(sumsFile)) {
    for (const line of fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue
      const m = SUM_RE.exec(line)
      if (!m) errors.push(`${sumsFile}: cannot read the line ${JSON.stringify(line)}`)
      else sums.set(m[2], m[1])
    }
  }
  let checked = 0
  for (const a of artifacts) {
    const ok = a && ARCHES.includes(a.arch) && a.file === FILE_OF(a.arch) && typeof a.sha256 === 'string' && /^[0-9a-f]{64}$/.test(a.sha256) && Number.isInteger(a.size) && a.size > 0
    if (!ok) {
      errors.push(`${manifestFile}: an artifact is not a tessel-host program (${JSON.stringify(a)})`)
      continue
    }
    const file = path.join(dir, a.file)
    if (!fs.existsSync(file)) {
      if (required) errors.push(`${file} is missing`)
      continue
    }
    const bytes = fs.readFileSync(file)
    const sha = crypto.createHash('sha256').update(bytes).digest('hex')
    if (bytes.length !== a.size) errors.push(`${file} has ${bytes.length} bytes, the manifest says ${a.size}`)
    if (sha !== a.sha256) errors.push(`${file} does not match the manifest's SHA-256`)
    if (sums.size && sums.get(a.file) !== a.sha256) errors.push(`${sumsFile} and ${manifestFile} disagree on ${a.file}`)
    checked++
  }
  for (const a of present) if (!artifacts.some((x) => x && x.file === FILE_OF(a))) errors.push(`${path.join(dir, FILE_OF(a))} is there but not in ${manifestFile}`)
  return { errors, checked, version }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const { errors, checked, version } = checkHostResources(process.argv[2] || undefined)
  for (const e of errors) console.error(`check-host-resources: ${e}`)
  if (errors.length) process.exit(1)
  console.log(checked ? `check-host-resources: ok (tessel-host ${version}, ${checked} program${checked > 1 ? 's' : ''})` : 'check-host-resources: no tessel-host programs (hosts keep the shell-based Files path)')
}
