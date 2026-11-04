// resources/tmux: Tessel's own tmux for SSH hosts without one
// (src/main/ssh/bundledTmux.js), built by .github/workflows/tmux-static.yml.
// When the binaries are there, each must match SHA256SUMS ("<sha256 hex>
// linux-x64/tmux" per line, as sha256sum prints it), every binary must be
// listed, and VERSION must name the version. A checkout without them (the
// usual one: they are not in git) passes: the app then tells a host without
// tmux so, as before. Run by scripts/check-bundle.mjs, or alone:
//   node scripts/check-tmux-resources.mjs [resources/tmux]
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { fileURLToPath } from 'url'

const ARCHES = ['linux-x64', 'linux-arm64']
const SUM_RE = /^([0-9a-f]{64})\s+\*?(linux-(?:x64|arm64))\/tmux\s*$/

// -> { errors: [string], checked: number }
export function checkTmuxResources(dir = path.join('resources', 'tmux')) {
  const errors = []
  const present = ARCHES.filter((a) => fs.existsSync(path.join(dir, a, 'tmux')))
  const sumsFile = path.join(dir, 'SHA256SUMS')
  if (!present.length && !fs.existsSync(sumsFile)) return { errors, checked: 0 }
  if (!fs.existsSync(sumsFile)) {
    errors.push(`${sumsFile} is missing while ${present.map((a) => `${a}/tmux`).join(', ')} is there`)
    return { errors, checked: 0 }
  }
  const version = fs.existsSync(path.join(dir, 'VERSION')) ? fs.readFileSync(path.join(dir, 'VERSION'), 'utf8').trim() : ''
  if (!/^[0-9A-Za-z.-]{1,40}$/.test(version)) errors.push(`${path.join(dir, 'VERSION')} must name the tmux version (like 3.5a)`)
  const listed = new Map()
  for (const line of fs.readFileSync(sumsFile, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = SUM_RE.exec(line)
    if (!m) {
      errors.push(`${sumsFile}: cannot read the line ${JSON.stringify(line)} (expected "<sha256 hex>  linux-x64/tmux")`)
      continue
    }
    listed.set(m[2], m[1])
  }
  let checked = 0
  for (const [arch, expected] of listed) {
    const file = path.join(dir, arch, 'tmux')
    if (!fs.existsSync(file)) {
      errors.push(`${file} is listed in SHA256SUMS but missing`)
      continue
    }
    const actual = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
    if (actual !== expected) errors.push(`${file} does not match SHA256SUMS (${actual} instead of ${expected})`)
    else checked++
  }
  for (const arch of present) if (!listed.has(arch)) errors.push(`${path.join(dir, arch, 'tmux')} is not listed in SHA256SUMS`)
  return { errors, checked }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { errors, checked } = checkTmuxResources(process.argv[2] || undefined)
  for (const e of errors) console.error(`check-tmux-resources: ${e}`)
  if (errors.length) process.exit(1)
  console.log(checked ? `check-tmux-resources: ok (${checked} binaries)` : 'check-tmux-resources: no bundled tmux (the host is told when it has none)')
}
