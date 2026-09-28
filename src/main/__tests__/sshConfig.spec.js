// ~/.ssh/config parsing (sshConfig.js, ported from Orca's ssh-config-parser
// and include expander). Fixtures only: a throwaway HOME in the temp folder,
// never the user's real ~/.ssh.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  parseSshConfig,
  splitOpenSshArguments,
  loadUserSshConfig,
  loadUserSshConfigDetailed,
  expandSshConfigIncludes,
  expandSshConfigIncludesDetailed,
  resolveSshConfigHomePath,
  isKeyFileName,
  looksLikeKeyStart,
  SSH_CONFIG_LIMITS
} from '../sshConfig'

describe('parseSshConfig', () => {
  it('reads Host blocks with their HostName, Port, User and IdentityFile', () => {
    const hosts = parseSshConfig(
      [
        '# my servers',
        'Host prod',
        '  HostName prod.example.com',
        '  Port 2222',
        '  User deploy',
        '  IdentityFile ~/.ssh/id_prod',
        '',
        'Host box',
        '  HostName=10.0.0.5'
      ].join('\n'),
      { home: '/home/me' }
    )
    expect(hosts).toEqual([
      { host: 'prod', hostname: 'prod.example.com', port: 2222, user: 'deploy', identityFile: '/home/me/.ssh/id_prod' },
      { host: 'box', hostname: '10.0.0.5' }
    ])
  })

  it('skips wildcard and negated patterns, keeps the concrete aliases of a line', () => {
    const hosts = parseSshConfig(['Host *', '  User everyone', 'Host web-? !bad a b', '  User ops', 'Host *.corp'].join('\n'))
    expect(hosts.map((h) => h.host)).toEqual(['a', 'b'])
    expect(hosts.every((h) => h.user === 'ops')).toBe(true)
  })

  it('the first value wins for single-valued keys; Match ends a block', () => {
    const hosts = parseSshConfig(['Host a', '  User one', '  User two', 'Match host a', '  User three', 'Host b'].join('\n'))
    expect(hosts).toEqual([{ host: 'a', user: 'one' }, { host: 'b' }])
  })

  it('handles quotes, inline comments, CRLF and ProxyCommand/ProxyJump', () => {
    const hosts = parseSshConfig(
      'Host "my host" other # comment\r\n  HostName "srv.example.com" # trailing\r\n  ProxyCommand ssh -W %h:%p "gate #1"\r\n  ProxyJump bastion\r\n'
    )
    expect(hosts[0]).toMatchObject({ host: 'my host', hostname: 'srv.example.com', proxyCommand: 'ssh -W %h:%p "gate #1"', proxyJump: 'bastion' })
    expect(hosts[1].host).toBe('other')
  })

  it('splits OpenSSH arguments', () => {
    expect(splitOpenSshArguments('a "b c" d#e')).toEqual(['a', 'b c', 'd'])
  })

  it('resolves ~ against the given home', () => {
    expect(resolveSshConfigHomePath('~/.ssh/k', 'C:\\Users\\me')).toBe('C:\\Users\\me\\.ssh\\k')
    expect(resolveSshConfigHomePath('/abs/k', '/home/me')).toBe('/abs/k')
  })
})

describe('loadUserSshConfig (throwaway HOME)', () => {
  let home
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tessel-sshcfg-'))
    mkdirSync(join(home, '.ssh', 'conf.d'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('returns [] when there is no config', async () => {
    rmSync(join(home, '.ssh'), { recursive: true, force: true })
    expect(await loadUserSshConfig({ home })).toEqual([])
  })

  it('follows Include (relative, glob, sorted) and ignores cycles', async () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/*.conf\nHost main\n  HostName main.example\nInclude config\n')
    writeFileSync(join(home, '.ssh', 'conf.d', 'b.conf'), 'Host bee\n  User b\n')
    writeFileSync(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host ay\n  User a\n')
    writeFileSync(join(home, '.ssh', 'conf.d', 'skip.txt'), 'Host nope\n')
    const hosts = await loadUserSshConfig({ home })
    expect(hosts.map((h) => h.host)).toEqual(['ay', 'bee', 'main'])
  })

  it('skips an Include with a target-dependent token or a missing variable', async () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/%h.conf\nInclude ${TESSEL_NO_SUCH_VAR_X}/x\nHost only\n')
    writeFileSync(join(home, '.ssh', 'conf.d', '%h.conf'), 'Host bad\n')
    expect((await loadUserSshConfig({ home })).map((h) => h.host)).toEqual(['only'])
  })

  it('never opens identity files: only the config text is read', async () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Host k\n  IdentityFile ~/.ssh/id_test\n')
    writeFileSync(join(home, '.ssh', 'id_test'), 'PRIVATE KEY MATERIAL')
    const { fsApi, opened } = spyFs()
    const text = await expandSshConfigIncludes(join(home, '.ssh', 'config'), { home, fsApi })
    expect(text).toContain('IdentityFile')
    expect(opened.some((p) => p.endsWith('id_test'))).toBe(false)
    expect((await loadUserSshConfig({ home }))[0].identityFile).toBe(join(home, '.ssh', 'id_test'))
  })
})

// An fs whose opens and reads are recorded (the parser reads through
// fs.promises.open + FileHandle.read only).
function spyFs() {
  const opened = []
  const reads = []
  const promises = {
    ...nodeFs.promises,
    open: async (p, ...rest) => {
      opened.push(String(p))
      const fh = await nodeFs.promises.open(p, ...rest)
      const read = fh.read.bind(fh)
      fh.read = async (buf, off, len, pos) => {
        const r = await read(buf, off, len, pos)
        reads.push({ file: String(p), bytes: r.bytesRead })
        return r
      }
      return fh
    },
    readFile: async (p, ...rest) => {
      opened.push(String(p))
      return nodeFs.promises.readFile(p, ...rest)
    }
  }
  return { fsApi: { ...nodeFs, promises }, opened, reads }
}

describe('Include never reads key files (Codex review, defect 2)', () => {
  let home
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tessel-sshkeys-'))
    mkdirSync(join(home, '.ssh'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  const PEM = '-----BEGIN OPENSSH PRIVATE KEY-----\nFIXTURE-NOT-A-KEY\n-----END OPENSSH PRIVATE KEY-----\n'

  it('Include * inside ~/.ssh skips keys by name, .pub pairs, known_hosts and authorized_keys', async () => {
    const ssh = join(home, '.ssh')
    writeFileSync(join(ssh, 'config'), 'Include *\nHost local\n')
    writeFileSync(join(ssh, 'id_ed25519'), PEM)
    writeFileSync(join(ssh, 'id_ed25519.pub'), 'ssh-ed25519 AAAA fixture')
    writeFileSync(join(ssh, 'deploy.pem'), PEM)
    writeFileSync(join(ssh, 'server.key'), PEM)
    writeFileSync(join(ssh, 'work'), PEM) // an ordinary name, but it has work.pub
    writeFileSync(join(ssh, 'work.pub'), 'ssh-rsa AAAA fixture')
    writeFileSync(join(ssh, 'known_hosts'), 'host ssh-ed25519 AAAA')
    writeFileSync(join(ssh, 'known_hosts.old'), 'host ssh-ed25519 AAAA')
    writeFileSync(join(ssh, 'authorized_keys'), 'ssh-ed25519 AAAA')
    writeFileSync(join(ssh, 'extra.conf'), 'Host extra\n')
    const { fsApi, opened } = spyFs()
    const hosts = await loadUserSshConfig({ home, fsApi })
    expect(hosts.map((h) => h.host)).toEqual(['extra', 'local'])
    const names = opened.map((p) => p.split(/[\\/]/).pop())
    expect(names.sort()).toEqual(['config', 'extra.conf'])
  })

  it('a key under another name is dropped after its first 64 bytes, never read whole', async () => {
    const ssh = join(home, '.ssh')
    writeFileSync(join(ssh, 'config'), 'Include backup/*\nHost local\n')
    mkdirSync(join(ssh, 'backup'))
    writeFileSync(join(ssh, 'backup', 'mystery'), PEM + 'x'.repeat(10000))
    writeFileSync(join(ssh, 'backup', 'putty'), 'PuTTY-User-Key-File-3: ssh-ed25519\n' + 'y'.repeat(5000))
    writeFileSync(join(ssh, 'backup', 'bom'), '﻿  -----BEGIN RSA PRIVATE KEY-----\n' + 'z'.repeat(5000))
    const { fsApi, reads } = spyFs()
    const hosts = await loadUserSshConfig({ home, fsApi })
    expect(hosts.map((h) => h.host)).toEqual(['local'])
    const keyReads = reads.filter((r) => !r.file.endsWith('config'))
    expect(keyReads.length).toBe(3)
    for (const r of keyReads) expect(r.bytes).toBeLessThanOrEqual(64)
    expect(isKeyFileName('id_rsa')).toBe(true)
    expect(isKeyFileName('conf.d')).toBe(false)
    expect(looksLikeKeyStart(Buffer.from('Host x\n'))).toBe(false)
  })
})

describe('one budget for the whole parse (Codex review, defect 3)', () => {
  let home
  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'tessel-sshbudget-'))
    mkdirSync(join(home, '.ssh', 'inc'), { recursive: true })
  })
  afterEach(() => rmSync(home, { recursive: true, force: true }))

  it('9 levels each including the next twice (Codex fixture): stops at the budget, no amplification', async () => {
    const inc = join(home, '.ssh', 'inc')
    for (let i = 0; i < 9; i++) writeFileSync(join(inc, `f${i}`), `Include inc/f${i + 1}\nInclude inc/f${i + 1}\n`)
    writeFileSync(join(inc, 'f9'), '#' + 'x'.repeat(4095) + '\n')
    writeFileSync(join(home, '.ssh', 'config'), 'Include inc/f0\nHost after\n')
    const res = await expandSshConfigIncludesDetailed(join(home, '.ssh', 'config'), { home })
    expect(res.truncated).toBe(true)
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxExpandedBytes)
    expect(Buffer.byteLength(res.text)).toBeLessThan(1024 * 1024)
    expect(res.stats.expansions).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxExpansions)
    expect(res.stats.files).toBeLessThanOrEqual(11)
    expect(res.stats.readBytes).toBeLessThan(64 * 1024)
  })

  it('depth 16 with fanout 256 (glob) stays within every limit', async () => {
    const inc = join(home, '.ssh', 'inc')
    // Each level: a directory of 256 files that all include the next level.
    for (let d = 0; d < 16; d++) {
      mkdirSync(join(inc, `l${d}`))
      for (let k = 0; k < 256; k++) writeFileSync(join(inc, `l${d}`, `c${k}.conf`), `Include inc/l${d + 1}/*.conf\nHost h${d}x${k}\n`)
    }
    writeFileSync(join(home, '.ssh', 'config'), 'Include inc/l0/*.conf\n')
    const started = Date.now()
    const res = await expandSshConfigIncludesDetailed(join(home, '.ssh', 'config'), { home })
    expect(res.truncated).toBe(true)
    expect(res.stats.expansions).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxExpansions)
    expect(res.stats.files).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxFiles)
    expect(res.stats.globEntries).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxGlobEntries)
    expect(res.stats.globMatches).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxGlobMatches)
    expect(res.stats.readBytes).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxReadBytes)
    expect(Buffer.byteLength(res.text)).toBeLessThanOrEqual(SSH_CONFIG_LIMITS.maxExpandedBytes)
    expect(Date.now() - started).toBeLessThan(15000)
  }, 60000)

  it('a file over the per-file cap is skipped unread; the read budget stops before allocating', async () => {
    const inc = join(home, '.ssh', 'inc')
    writeFileSync(join(inc, 'huge'), 'Host huge\n' + '#'.repeat(SSH_CONFIG_LIMITS.maxFileBytes + 10))
    writeFileSync(join(inc, 'a'), 'Host a\n' + '#'.repeat(3000) + '\n')
    writeFileSync(join(inc, 'b'), 'Host b\n' + '#'.repeat(3000) + '\n')
    writeFileSync(join(home, '.ssh', 'config'), 'Include inc/huge inc/a inc/b\nHost main\n')
    const { fsApi, opened } = spyFs()
    const res = await loadUserSshConfigDetailed({ home, fsApi, limits: { maxReadBytes: 4000 } })
    expect(opened.some((p) => p.endsWith('huge'))).toBe(false)
    expect(res.hosts.map((h) => h.host)).toEqual(['a'])
    expect(res.truncated).toBe(true)
  })

  it('the parse is asynchronous: the caller gets a promise', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Host x\n')
    const p = loadUserSshConfig({ home })
    expect(typeof p.then).toBe('function')
    return p
  })
})
