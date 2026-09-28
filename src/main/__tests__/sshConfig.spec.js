// ~/.ssh/config parsing (sshConfig.js, ported from Orca's ssh-config-parser
// and include expander). Fixtures only: a throwaway HOME in the temp folder,
// never the user's real ~/.ssh.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as nodeFs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseSshConfig, splitOpenSshArguments, loadUserSshConfig, expandSshConfigIncludes, resolveSshConfigHomePath } from '../sshConfig'

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

  it('returns [] when there is no config', () => {
    rmSync(join(home, '.ssh'), { recursive: true, force: true })
    expect(loadUserSshConfig({ home })).toEqual([])
  })

  it('follows Include (relative, glob, sorted) and ignores cycles', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/*.conf\nHost main\n  HostName main.example\nInclude config\n')
    writeFileSync(join(home, '.ssh', 'conf.d', 'b.conf'), 'Host bee\n  User b\n')
    writeFileSync(join(home, '.ssh', 'conf.d', 'a.conf'), 'Host ay\n  User a\n')
    writeFileSync(join(home, '.ssh', 'conf.d', 'skip.txt'), 'Host nope\n')
    const hosts = loadUserSshConfig({ home })
    expect(hosts.map((h) => h.host)).toEqual(['ay', 'bee', 'main'])
  })

  it('skips an Include with a target-dependent token or a missing variable', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Include conf.d/%h.conf\nInclude ${TESSEL_NO_SUCH_VAR_X}/x\nHost only\n')
    writeFileSync(join(home, '.ssh', 'conf.d', '%h.conf'), 'Host bad\n')
    expect(loadUserSshConfig({ home }).map((h) => h.host)).toEqual(['only'])
  })

  it('never opens identity files: only the config text is read', () => {
    writeFileSync(join(home, '.ssh', 'config'), 'Host k\n  IdentityFile ~/.ssh/id_test\n')
    writeFileSync(join(home, '.ssh', 'id_test'), 'PRIVATE KEY MATERIAL')
    const read = []
    const fsApi = {
      ...nodeFs,
      readFileSync: (p, ...rest) => {
        read.push(String(p))
        return nodeFs.readFileSync(p, ...rest)
      }
    }
    const text = expandSshConfigIncludes(join(home, '.ssh', 'config'), { home, fsApi })
    expect(text).toContain('IdentityFile')
    expect(read.some((p) => p.endsWith('id_test'))).toBe(false)
    expect(loadUserSshConfig({ home })[0].identityFile).toBe(join(home, '.ssh', 'id_test'))
  })
})
