// Builds Tessel's SSH_ASKPASS helper (src/main/askpass/TesselAskpass.cs) into
// out/main/tessel-askpass.exe, with the C# compiler of the .NET Framework 4
// that ships with Windows 10 / 11 (no SDK, no download). Called by the main
// build (electron.vite.config.mjs) and usable alone:
//   node scripts/build-askpass.mjs [out.exe]
// The result is cached by source hash in the temp folder, so dev rebuilds
// do not run the compiler each time.
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import { execFileSync } from 'child_process'
import { fileURLToPath } from 'url'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export const ASKPASS_SOURCE = path.join(root, 'src', 'main', 'askpass', 'TesselAskpass.cs')
export const ASKPASS_EXE = 'tessel-askpass.exe'

export function findCsc(env = process.env) {
  const win = env.SystemRoot || env.windir || 'C:\\Windows'
  for (const fw of ['Framework64', 'Framework']) {
    const p = path.join(win, 'Microsoft.NET', fw, 'v4.0.30319', 'csc.exe')
    if (fs.existsSync(p)) return p
  }
  return null
}

function sameFile(a, b) {
  try {
    return fs.readFileSync(a).equals(fs.readFileSync(b))
  } catch {
    return false
  }
}

// -> { ok, file, cached? } or { ok: false, error }
export function buildAskpass(outFile) {
  if (process.platform !== 'win32') return { ok: false, error: 'the askpass helper is built on Windows only' }
  const csc = findCsc()
  if (!csc) return { ok: false, error: 'csc.exe (.NET Framework 4) not found' }
  const source = fs.readFileSync(ASKPASS_SOURCE)
  const hash = crypto.createHash('sha256').update(source).digest('hex').slice(0, 16)
  const cacheDir = path.join(os.tmpdir(), 'tessel-askpass-build')
  const cached = path.join(cacheDir, `${hash}.exe`)
  fs.mkdirSync(path.dirname(outFile), { recursive: true })
  if (fs.existsSync(cached)) {
    // Already there (a dev rebuild): left alone, it may be running.
    if (!sameFile(cached, outFile)) fs.copyFileSync(cached, outFile)
    return { ok: true, file: outFile, cached: true }
  }
  fs.mkdirSync(cacheDir, { recursive: true })
  const tmp = path.join(cacheDir, `${hash}-${process.pid}.exe`)
  try {
    execFileSync(csc, ['-nologo', '-optimize+', '-target:exe', '-platform:anycpu', `-out:${tmp}`, ASKPASS_SOURCE], {
      stdio: 'pipe',
      windowsHide: true
    })
  } catch (err) {
    const out = `${err.stdout || ''}${err.stderr || ''}`.trim()
    return { ok: false, error: `csc failed: ${out || err.message}` }
  }
  try {
    fs.renameSync(tmp, cached)
  } catch {
    /* another build got there first */
  }
  fs.copyFileSync(fs.existsSync(cached) ? cached : tmp, outFile)
  return { ok: true, file: outFile, cached: false }
}

// Vite / Rollup plugin for the main build: the helper lands next to index.js.
export function askpassPlugin() {
  let outDir = path.join(root, 'out', 'main')
  return {
    name: 'tessel-askpass-helper',
    apply: 'build',
    configResolved(config) {
      if (config.build && config.build.outDir) outDir = path.resolve(config.root || root, config.build.outDir)
    },
    writeBundle() {
      const res = buildAskpass(path.join(outDir, ASKPASS_EXE))
      if (!res.ok) this.warn(`SSH askpass helper not built (${res.error}): SSH passwords will be typed in the terminal`)
    }
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const res = buildAskpass(path.resolve(process.argv[2] || path.join(root, 'out', 'main', ASKPASS_EXE)))
  if (!res.ok) {
    console.error(`build-askpass: ${res.error}`)
    process.exit(1)
  }
  console.log(`build-askpass: ${res.file}${res.cached ? ' (cached)' : ''}`)
}
