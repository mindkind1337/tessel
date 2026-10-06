// @vitest-environment node
// Claude Code's skills on an SSH host (remoteSkills.js): the host's listing
// (fake, no server) turned into the chat's skill rows, kept a while, and the
// chat view over a terminal agent there asking the host, never this PC.
import { describe, expect, it, vi } from 'vitest'
import { remoteSkillDiscovery, createRemoteSkills } from '../remoteSkills'
import { createTerminalSkills } from '../terminalSkills'
import { parseSkillListing } from '../../remoteFs'

const HOST = 'ssh-box1'
const skill = (name, description) => `---\nname: ${name}\ndescription: ${description}\n---\nbody\n`

describe('the host listing', () => {
  it('parses @@S records; drops relative, odd or repeated paths', () => {
    const b64 = (s) => Buffer.from(s).toString('base64')
    const out = [
      'noise',
      `@@S home ${b64('/home/me/.claude/skills/review/SKILL.md')}`,
      b64(skill('review', 'Review a diff')),
      `@@S repo ${b64('relative/SKILL.md')}`,
      b64('x'),
      `@@S repo ${b64('/home/me/app/.claude/skills/a/README.md')}`,
      b64('x'),
      `@@S home ${b64('/home/me/.claude/skills/review/SKILL.md')}`,
      b64('again'),
      `@@S other ${b64('/x/SKILL.md')}`,
      b64('x')
    ].join('\n')
    expect(parseSkillListing(out)).toEqual([{ kind: 'home', path: '/home/me/.claude/skills/review/SKILL.md', text: skill('review', 'Review a diff') }])
  })

  it("rows like the local discovery's; the project's skill wins over the user's of the same name", () => {
    const r = remoteSkillDiscovery(
      [
        { kind: 'home', path: '/home/me/.claude/skills/review/SKILL.md', text: skill('review', 'Mine') },
        { kind: 'home', path: '/home/me/.claude/skills/notes/SKILL.md', text: 'no frontmatter at all' },
        { kind: 'repo', path: '/srv/app/.claude/skills/review/SKILL.md', text: skill('review', 'The project one') },
        { kind: 'repo', path: '/srv/app/elsewhere/SKILL.md', text: skill('odd', 'not in a skills folder') }
      ],
      () => 5
    )
    expect(r.scannedAt).toBe(5)
    expect(r.skills.map((s) => [s.name, s.description, s.sourceKind])).toEqual([
      ['notes', null, 'home'],
      ['review', 'The project one', 'repo']
    ])
    expect(r.skills[1]).toMatchObject({ rootPath: '/srv/app/.claude/skills', directoryPath: '/srv/app/.claude/skills/review', skillFilePath: '/srv/app/.claude/skills/review/SKILL.md', providers: ['claude'] })
    expect(r.sources.map((s) => s.path)).toEqual(['/home/me/.claude/skills', '/srv/app/.claude/skills'])
  })

  it('one listing at a time per host and project, kept 30 s; a refresh asks again; a bad host never asks', async () => {
    let t = 1000
    let release
    const listSkills = vi.fn(() => new Promise((res) => (release = () => res({ ok: true, files: [{ kind: 'home', path: '/h/.claude/skills/a/SKILL.md', text: skill('a', 'A') }] }))))
    const rs = createRemoteSkills({ listSkills, now: () => t })
    const one = rs.skills({ hostId: HOST, project: '/srv/app' })
    const two = rs.skills({ hostId: HOST, project: '/srv/app' })
    release()
    expect((await one).result.skills[0].name).toBe('a')
    expect(await two).toEqual(await one)
    expect(listSkills).toHaveBeenCalledTimes(1)
    expect(listSkills).toHaveBeenCalledWith(HOST, { project: '/srv/app' })
    await rs.skills({ hostId: HOST, project: '/srv/app' })
    expect(listSkills).toHaveBeenCalledTimes(1)
    t += 31000
    const again = rs.skills({ hostId: HOST, project: '/srv/app' })
    release()
    await again
    expect(listSkills).toHaveBeenCalledTimes(2)
    expect(await rs.skills({ hostId: 'C:\\x' })).toEqual({ ok: false })
    expect(listSkills).toHaveBeenCalledTimes(2)
    const off = createRemoteSkills({ listSkills: async () => ({ ok: false, notConnected: true }) })
    expect(await off.skills({ hostId: HOST })).toEqual({ ok: false, notConnected: true })
  })
})

describe("a terminal agent's chat view on a host", () => {
  const views = (map) => ({
    agentOf: (id) => map[id]?.agent || null,
    cwdOf: () => null,
    hostOf: (id) => map[id]?.hostId || null,
    remoteCwdOf: (id) => map[id]?.cwd || null
  })

  it('lists the host skills with the folder its file names; never scans this PC', async () => {
    const discover = vi.fn()
    const remoteSkills = vi.fn(async () => ({ ok: true, result: remoteSkillDiscovery([{ kind: 'repo', path: '/srv/app/.claude/skills/ship/SKILL.md', text: skill('ship', 'Ship') }]) }))
    const s = createTerminalSkills({ views: views({ 'tv-1': { agent: 'claude', hostId: HOST, cwd: '/srv/app' }, 'tv-2': { agent: 'codex', hostId: HOST } }), discover, remoteSkills })
    const r = await s.skills({ agent: 'claude', viewId: 'tv-1', refresh: true })
    expect(remoteSkills).toHaveBeenCalledWith({ hostId: HOST, project: '/srv/app', refresh: true })
    expect(r.ok).toBe(true)
    expect(r.result.skills.map((x) => x.name)).toEqual(['ship'])
    expect(JSON.stringify(r.result)).not.toContain('/srv/app')
    expect(discover).not.toHaveBeenCalled()
    // Codex on a host: not listed (nor this PC's).
    expect((await s.skills({ agent: 'codex', viewId: 'tv-2' })).ok).toBe(false)
    expect(discover).not.toHaveBeenCalled()
  })

  it('without the host lister: unavailable, still never a local scan', async () => {
    const discover = vi.fn()
    const s = createTerminalSkills({ views: views({ 'tv-1': { agent: 'claude', hostId: HOST } }), discover })
    expect((await s.skills({ agent: 'claude', viewId: 'tv-1' })).ok).toBe(false)
    expect(discover).not.toHaveBeenCalled()
  })
})
