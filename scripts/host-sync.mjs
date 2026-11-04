// Copies a release of tessel-host (mindkind1337/tessel-host, private) into
// resources/host: its manifest.json, SHA256SUMS, LICENSE and the two static
// programs, downloaded with the GitHub CLI (signed in with access to that
// repository), checked against SHA256SUMS and the manifest before anything
// is written in place. The app never downloads anything at run time: these
// files are committed with the app (src/main/host/bundled.ts reads them).
//   node scripts/host-sync.mjs v0.1.1
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { checkHostResources } from './check-host-resources.mjs'

const REPO = 'mindkind1337/tessel-host'
const FILES = ['manifest.json', 'SHA256SUMS', 'LICENSE', 'tessel-host-x86_64-unknown-linux-musl', 'tessel-host-aarch64-unknown-linux-musl']

const tag = process.argv[2]
if (!tag || !/^v[0-9][0-9a-z.-]{0,31}$/.test(tag)) {
  console.error('usage: node scripts/host-sync.mjs v<version>')
  process.exit(2)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tessel-host-sync-'))
try {
  execFileSync('gh', ['release', 'download', tag, '-R', REPO, '-D', tmp, '--clobber', ...FILES.flatMap((f) => ['-p', f])], { stdio: 'inherit' })
  for (const f of FILES) if (!fs.existsSync(path.join(tmp, f))) throw new Error(`${f} is not among the release's assets`)
  // SHA256SUMS first (the release's own statement), then the manifest.
  const sums = fs.readFileSync(path.join(tmp, 'SHA256SUMS'), 'utf8')
  for (const line of sums.split(/\r?\n/)) {
    if (!line.trim()) continue
    const m = /^([0-9a-f]{64})\s+\*?(\S+)\s*$/.exec(line)
    if (!m || !FILES.includes(m[2])) throw new Error(`SHA256SUMS: cannot read ${JSON.stringify(line)}`)
    const sha = crypto.createHash('sha256').update(fs.readFileSync(path.join(tmp, m[2]))).digest('hex')
    if (sha !== m[1]) throw new Error(`${m[2]} does not match SHA256SUMS`)
  }
  const check = checkHostResources(tmp, { required: true })
  if (check.errors.length) throw new Error(check.errors.join('\n'))
  if (`v${check.version}` !== tag) throw new Error(`the manifest says ${check.version}, the tag is ${tag}`)
  const dest = path.join('resources', 'host')
  fs.mkdirSync(dest, { recursive: true })
  for (const old of fs.readdirSync(dest)) if (!FILES.includes(old)) fs.rmSync(path.join(dest, old), { force: true })
  for (const f of FILES) fs.copyFileSync(path.join(tmp, f), path.join(dest, f))
  console.log(`host-sync: tessel-host ${check.version} (${check.checked} programs) in ${dest}`)
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}
