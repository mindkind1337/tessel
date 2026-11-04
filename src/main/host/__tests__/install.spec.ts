// @vitest-environment node
// The install plan is a port of tessel_host::install: the commands below are
// what the Rust function prints for the same inputs, written out so a drift
// on either side shows here.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { archFromUname, checkVersion, commands, matches, parseDigest, parseManifest, plan, sha256Hex } from '../install'

const BIN = '$HOME/.tessel-server/host/bin'
const NO_LINKS = '[ ! -L "$HOME/.tessel-server" ] && [ ! -L "$HOME/.tessel-server/host" ] && [ ! -L "$HOME/.tessel-server/host/bin" ]'

describe('install plan', () => {
  it('builds the exact commands of tessel_host::install::plan', () => {
    const p = plan('0.1.1', 'x86_64', '0123456789abcdef')!
    const installed = `${BIN}/tessel-host-0.1.1-x86_64`
    const part = `${BIN}/.tessel-host-0.1.1-x86_64.0123456789abcdef.part`
    expect(p).toEqual({
      probe: 'uname -m',
      upload: `umask 077 && ${NO_LINKS} && mkdir -p "${BIN}" && ${NO_LINKS} && cat > "${part}"`,
      digest: `if command -v sha256sum >/dev/null 2>&1; then sha256sum "${part}"; else busybox sha256sum "${part}"; fi`,
      activate: `chmod 700 "${part}" && mv -f "${part}" "${installed}" && "${installed}" version`,
      abort: `rm -f "${part}"`,
      installed,
      version: `"${installed}" version`,
      connect: `"${installed}" connect --stdio`
    })
    expect(plan('0.1.1', 'aarch64', 'ffffffffffffffff')!.connect).toBe(`"${BIN}/tessel-host-0.1.1-aarch64" connect --stdio`)
  })

  it('matches tessel-host’s own fixture (fixtures/install/plan.json, checked there against install::plan by CI) byte for byte', () => {
    const fixture = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'install-plan.json'), 'utf8')) as {
      version: string
      nonce: string
      plans: Record<string, Record<string, string>>
    }
    for (const arch of ['x86_64', 'aarch64'] as const) {
      const p = plan(fixture.version, arch, fixture.nonce)
      expect(p, arch).toEqual(fixture.plans[arch])
    }
  })

  it('refuses a version or a nonce that is not a plain token', () => {
    expect(plan('0.1.1; rm -rf /', 'x86_64', '0123456789abcdef')).toBeNull()
    expect(plan('0.1.1', 'x86_64', '0123456789ABCDEF')).toBeNull()
    expect(plan('0.1.1', 'x86_64', '0123')).toBeNull()
    expect(plan('', 'x86_64', '0123456789abcdef')).toBeNull()
    expect(plan('v'.repeat(33), 'x86_64', '0123456789abcdef')).toBeNull()
    expect(plan('A.1', 'x86_64', '0123456789abcdef')).toBeNull()
  })

  it('commands: the version and connect commands without a nonce', () => {
    expect(commands('0.1.1', 'x86_64')).toEqual({
      version: `"${BIN}/tessel-host-0.1.1-x86_64" version`,
      connect: `"${BIN}/tessel-host-0.1.1-x86_64" connect --stdio`
    })
  })

  it('reads uname, a digest line and the installed version line', () => {
    expect(archFromUname('x86_64\n')).toBe('x86_64')
    expect(archFromUname('amd64')).toBe('x86_64')
    expect(archFromUname(' aarch64 ')).toBe('aarch64')
    expect(archFromUname('arm64')).toBe('aarch64')
    expect(archFromUname('armv7l')).toBeNull()
    const d = 'A'.repeat(64)
    expect(parseDigest(`${d}  /home/u/.tessel-server/host/bin/.part\n`)).toBe('a'.repeat(64))
    expect(parseDigest('sha256sum: no such file')).toBeNull()
    expect(parseDigest('')).toBeNull()
    const line = '{"name":"tessel-host","version":"0.1.1","arch":"x86_64","protocol":[1]}\n'
    expect(checkVersion(line, '0.1.1', 'x86_64')).toBe(true)
    expect(checkVersion(line, '0.1.0', 'x86_64')).toBe(false)
    expect(checkVersion(line, '0.1.1', 'aarch64')).toBe(false)
    expect(checkVersion('{"name":"tessel-host","version":"0.1.1","arch":"x86_64","protocol":[2]}', '0.1.1', 'x86_64')).toBe(false)
    expect(checkVersion('not json', '0.1.1', 'x86_64')).toBe(false)
  })

  it('accepts the release manifest and refuses a tampered one', () => {
    const text = JSON.stringify({
      version: '0.1.1',
      artifacts: [
        { arch: 'x86_64', target: 'x86_64-unknown-linux-musl', file: 'tessel-host-x86_64-unknown-linux-musl', size: 1631048, sha256: '1'.repeat(64) },
        { arch: 'aarch64', target: 'aarch64-unknown-linux-musl', file: 'tessel-host-aarch64-unknown-linux-musl', size: 1406808, sha256: '2'.repeat(64) }
      ]
    })
    const m = parseManifest(text)!
    expect(m.version).toBe('0.1.1')
    expect(m.artifacts.map((a) => a.arch)).toEqual(['x86_64', 'aarch64'])
    const edit = (f: (o: { artifacts: Record<string, unknown>[] }) => void): string => {
      const o = JSON.parse(text) as { artifacts: Record<string, unknown>[] }
      f(o)
      return JSON.stringify(o)
    }
    expect(parseManifest(edit((o) => (o.artifacts[0]!.file = '../../evil')))).toBeNull()
    expect(parseManifest(edit((o) => (o.artifacts[0]!.sha256 = 'xyz')))).toBeNull()
    expect(parseManifest(edit((o) => (o.artifacts[0]!.size = 0)))).toBeNull()
    expect(parseManifest(edit((o) => (o.artifacts[0]!.extra = 1)))).toBeNull()
    expect(parseManifest(edit((o) => o.artifacts.push({ ...o.artifacts[0]! })))).toBeNull()
    expect(parseManifest('{"version":"0.1.1","artifacts":[]}')).toBeNull()
    expect(parseManifest('nope')).toBeNull()
  })

  it('matches bytes against an artifact by size and digest', () => {
    const bytes = Buffer.from('program')
    const artifact = { arch: 'x86_64' as const, target: 'x86_64-unknown-linux-musl', file: 'tessel-host-x86_64-unknown-linux-musl', size: 7, sha256: sha256Hex(bytes) }
    expect(matches(artifact, bytes)).toBe(true)
    expect(matches(artifact, Buffer.from('programs'))).toBe(false)
    expect(matches({ ...artifact, sha256: '0'.repeat(64) }, bytes)).toBe(false)
  })
})
