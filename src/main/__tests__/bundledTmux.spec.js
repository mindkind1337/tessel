// @vitest-environment node
// Tessel's own tmux shipped beside the app (ssh/bundledTmux.js): found from
// VERSION and SHA256SUMS, each binary checked against its sum before it is
// sent to a host; a checkout without the binaries has no bundle.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import crypto from 'crypto'
import { join } from 'path'
import { loadBundledTmux, bundledTmuxDir, tmuxArchFor, TMUX_ARCHES } from '../ssh/bundledTmux'

const sha = (b) => crypto.createHash('sha256').update(b).digest('hex')
let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-btmux-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

function bundle({ version = '3.5a', arches = TMUX_ARCHES, sums = null } = {}) {
  fs.writeFileSync(join(dir, 'VERSION'), `${version}\n`)
  const lines = []
  for (const arch of arches) {
    const bytes = Buffer.from(`ELF ${arch} ${version}`)
    fs.mkdirSync(join(dir, arch), { recursive: true })
    fs.writeFileSync(join(dir, arch, 'tmux'), bytes)
    lines.push(`${sha(bytes)}  ${arch}/tmux`)
  }
  fs.writeFileSync(join(dir, 'SHA256SUMS'), sums == null ? lines.join('\n') + '\n' : sums)
}

describe('the bundled tmux', () => {
  it('is found where the app keeps its resources: beside a packaged app, in resources/tmux of a checkout', () => {
    expect(bundledTmuxDir({ packaged: true, resourcesPath: 'C:\\App\\resources', appPath: 'C:\\App\\resources\\app.asar' })).toBe(join('C:\\App\\resources', 'tmux'))
    expect(bundledTmuxDir({ packaged: false, resourcesPath: 'x', appPath: 'C:\\Tessel' })).toBe(join('C:\\Tessel', 'resources', 'tmux'))
  })

  it('maps uname -m to a folder: Linux x86_64 and aarch64 only', () => {
    expect(tmuxArchFor('x86_64')).toBe('linux-x64')
    expect(tmuxArchFor('amd64\n')).toBe('linux-x64')
    expect(tmuxArchFor('aarch64')).toBe('linux-arm64')
    expect(tmuxArchFor('arm64')).toBe('linux-arm64')
    for (const other of ['armv7l', 'i686', 'mips', 'riscv64', '', null, undefined]) expect(tmuxArchFor(other)).toBe(null)
  })

  it('reads VERSION and SHA256SUMS once and gives each listed binary with its sum, its bytes checked when read', () => {
    bundle()
    const b = loadBundledTmux(dir)
    expect(b.version).toBe('3.5a')
    expect(b.arches).toEqual(['linux-x64', 'linux-arm64'])
    expect(b.file('linux-x64')).toBe(join(dir, 'linux-x64', 'tmux'))
    expect(b.sha256('linux-arm64')).toBe(sha(Buffer.from('ELF linux-arm64 3.5a')))
    expect(b.read('linux-x64').equals(Buffer.from('ELF linux-x64 3.5a'))).toBe(true)
    expect(b.file('linux-mips')).toBe(null)
    expect(b.read('linux-mips')).toBe(null)
    // A binary changed after the sums were written is never sent.
    fs.writeFileSync(join(dir, 'linux-x64', 'tmux'), 'tampered')
    const logs = []
    const again = loadBundledTmux(dir, { log: (m) => logs.push(m) })
    expect(again.read('linux-x64')).toBe(null)
    expect(logs.some((m) => m.includes('does not match'))).toBe(true)
  })

  it('takes the sha256sum formats (two spaces, or a star for binary mode) and skips lines it cannot read', () => {
    const bytes = Buffer.from('ELF linux-x64 3.5a')
    bundle({ arches: ['linux-x64'], sums: `${sha(bytes)} *linux-x64/tmux\n# a comment\n${'0'.repeat(64)}  linux-arm64/tmux\n` })
    const b = loadBundledTmux(dir)
    expect(b.arches).toEqual(['linux-x64'])
    expect(b.sha256('linux-x64')).toBe(sha(bytes))
  })

  it('no bundle without the folder, VERSION, SHA256SUMS or any listed binary (the usual checkout)', () => {
    expect(loadBundledTmux(join(dir, 'missing'))).toBe(null)
    expect(loadBundledTmux(null)).toBe(null)
    fs.writeFileSync(join(dir, 'VERSION'), '3.5a\n')
    expect(loadBundledTmux(dir)).toBe(null)
    fs.writeFileSync(join(dir, 'SHA256SUMS'), `${'a'.repeat(64)}  linux-x64/tmux\n`)
    expect(loadBundledTmux(dir)).toBe(null)
    bundle({ version: 'not a version!' })
    expect(loadBundledTmux(dir)).toBe(null)
  })
})
