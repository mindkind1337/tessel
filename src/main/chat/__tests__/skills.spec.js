// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import {
  discoverClaudeSkills,
  codexSkillDiscovery,
  skillFrontmatter,
  publicSkillDiscovery
} from '../skills.js'
let temp, cwd, home
beforeEach(async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), 'tessel-skills-'))
  cwd = path.join(temp, 'project')
  home = path.join(temp, 'home')
  await fs.mkdir(cwd)
  await fs.mkdir(home)
})
afterEach(async () => {
  await fs.rm(temp, { recursive: true, force: true })
})
async function fixture(
  file,
  content = '---\nname: fixture\ndescription: "Read only"\n---\nSECRET BODY'
) {
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, content)
}
describe('read-only skill discovery', () => {
  it('skips 64 KiB frontmatter lines promptly and strips scalar comments linearly', () => {
    const started = performance.now()
    expect(
      skillFrontmatter('---\nname: safe\ndescription: x' + ' '.repeat(65536) + 'x\n---', 'fallback')
    ).toEqual({ name: 'safe', description: null })
    expect(performance.now() - started).toBeLessThan(500)
    expect(
      skillFrontmatter('---\nname: safe # note\ndescription: issue#42\t# hidden\n---', 'fallback')
    ).toEqual({ name: 'safe', description: 'issue#42' })
  })

  it('refuses hard-linked skill files before opening their contents', async () => {
    const outside = path.join(temp, 'outside.md'),
      file = path.join(cwd, '.claude/skills/linked/SKILL.md')
    await fixture(outside)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.link(outside, file)
    const open = vi.fn((...args) => fs.open(...args))
    const result = await discoverClaudeSkills({ cwd, home, io: { ...fs, open } })
    expect(result.skills).toEqual([])
    expect(open).not.toHaveBeenCalled()
  })

  it.each(['dev', 'ino', 'nlink'])(
    'refuses an opened file with changed %s without reading, and closes it',
    async (field) => {
      await fixture(path.join(cwd, '.claude/skills/review/SKILL.md'))
      const read = vi.fn(),
        close = vi.fn()
      const open = async (...args) => {
        const handle = await fs.open(...args)
        return {
          stat: async (options) => {
            const stat = await handle.stat(options)
            stat[field] += 1n
            return stat
          },
          read,
          close: async () => {
            close()
            await handle.close()
          }
        }
      }
      const result = await discoverClaudeSkills({ cwd, home, io: { ...fs, open } })
      expect(result.skills).toEqual([])
      expect(read).not.toHaveBeenCalled()
      expect(close).toHaveBeenCalledTimes(1)
    }
  )

  it.each(['dev', 'ino'])(
    'compares adjacent large %s values exactly and keeps metadata serializable',
    async (field) => {
      const file = path.join(cwd, '.claude/skills/review/SKILL.md')
      await fixture(file)
      const identity = 2n ** 60n
      expect(Number(identity)).toBe(Number(identity + 1n))
      for (const changed of [false, true]) {
        const lstat = vi.fn(async (target, options) => {
          const stat = await fs.lstat(target, options)
          if (target === file) stat[field] = options?.bigint ? identity : Number(identity)
          return stat
        })
        const read = vi.fn(),
          close = vi.fn(),
          statOptions = []
        const open = async (...args) => {
          const handle = await fs.open(...args)
          return {
            stat: async (options) => {
              statOptions.push(options)
              const stat = await handle.stat(options)
              const value = identity + (changed ? 1n : 0n)
              stat[field] = options?.bigint ? value : Number(value)
              return stat
            },
            read: (...args) => {
              read()
              return handle.read(...args)
            },
            close: async () => {
              close()
              await handle.close()
            }
          }
        }
        const result = await discoverClaudeSkills({ cwd, home, io: { ...fs, lstat, open } })
        expect(lstat).toHaveBeenCalledWith(file, { bigint: true })
        expect(statOptions).toEqual([{ bigint: true }])
        expect(close).toHaveBeenCalledTimes(1)
        if (changed) {
          expect(result.skills).toEqual([])
          expect(read).not.toHaveBeenCalled()
        } else {
          expect(read).toHaveBeenCalledTimes(1)
          expect(result.skills).toHaveLength(1)
          expect(result.skills[0].updatedAt).toBeTypeOf('number')
          expect(Number.isFinite(result.skills[0].updatedAt)).toBe(true)
          expect(() => JSON.stringify(result)).not.toThrow()
        }
      }
    }
  )

  it('uses consistent opaque references and preserves only the directory basename', async () => {
    await fixture(path.join(cwd, '.claude/skills/example/SKILL.md'))
    const raw = await discoverClaudeSkills({ cwd, home })
    raw.skills[0].rootPaths = [raw.skills[0].rootPath]
    const result = publicSkillDiscovery(raw)
    const skill = result.skills[0]
    expect(JSON.stringify(result)).not.toContain(temp)
    expect(JSON.stringify(result)).not.toContain('.claude')
    expect(result.sources.some((source) => source.path === skill.rootPath)).toBe(true)
    expect(skill.rootPaths).toEqual([skill.rootPath])
    expect(skill.directoryPath.endsWith('/example')).toBe(true)
    expect(skill.id).toBe(skill.skillFilePath)
    expect(publicSkillDiscovery(raw)).toEqual(result)
  })

  it('reads only frontmatter from approved root layouts, including shared and legacy commands', async () => {
    await fixture(path.join(cwd, '.claude/skills/example/SKILL.md'))
    await fixture(
      path.join(cwd, '.agents/skills/shared/SKILL.md'),
      '---\ndescription: >\n  Shared first\n  second\n---\nPRIVATE BODY'
    )
    await fixture(
      path.join(home, '.claude/commands/review.md'),
      '---\ndescription: Review a fixture\n---\nDO NOT RETURN THIS'
    )
    const result = await discoverClaudeSkills({ cwd, home })
    expect(result.skills.map((row) => row.name).sort()).toEqual(['fixture', 'review', 'shared'])
    expect(result.skills.find((row) => row.name === 'shared')).toMatchObject({
      description: 'Shared first second',
      providers: ['agent-skills'],
      installed: true
    })
    expect(JSON.stringify(result)).not.toMatch(/SECRET|PRIVATE|DO NOT RETURN|canonical/)
    expect(
      result.sources.find((source) => source.path === path.join(home, '.agents/skills'))
    ).toMatchObject({ exists: false, skippedReason: 'missing' })
  })
  it('rejects directory junctions at the root and inside it', async () => {
    const outside = path.join(temp, 'outside')
    await fixture(path.join(outside, 'escape/SKILL.md'))
    await fs.mkdir(path.join(cwd, '.claude'))
    await fs.symlink(
      outside,
      path.join(cwd, '.claude/skills'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    await fs.mkdir(path.join(home, '.claude/skills'), { recursive: true })
    await fs.symlink(
      outside,
      path.join(home, '.claude/skills/link'),
      process.platform === 'win32' ? 'junction' : 'dir'
    )
    const result = await discoverClaudeSkills({ cwd, home })
    expect(result.skills).toEqual([])
    expect(result.sources.filter((source) => source.skippedReason === 'unavailable')).toHaveLength(
      2
    )
  })
  it('bounds file size, depth, item count and total scan time', async () => {
    await fixture(path.join(cwd, '.claude/skills/large/SKILL.md'), 'x'.repeat(100))
    await fixture(path.join(cwd, '.agents/skills/deep/nested/SKILL.md'))
    const bounded = await discoverClaudeSkills({ cwd, home, limits: { bytes: 40, depth: 1 } })
    expect(bounded.skills).toEqual([])
    expect(bounded.sources.some((source) => source.skippedReason === 'unavailable')).toBe(true)
    let release
    const realpath = vi.fn(
      () =>
        new Promise((resolve) => {
          release = resolve
        })
    )
    try {
      const timed = await discoverClaudeSkills({
        cwd,
        home,
        limits: { time: 15 },
        io: { ...fs, realpath }
      })
      expect(timed.skills).toEqual([])
      expect(timed.sources.every((source) => source.skippedReason === 'unavailable')).toBe(true)
      for (let i = 0; i < 5; i++) {
        await expect(
          discoverClaudeSkills({ cwd: home, home, io: { ...fs, realpath } })
        ).rejects.toMatchObject({ code: 'SKILL_SCAN_BUSY' })
      }
      expect(realpath).toHaveBeenCalledTimes(1)
    } finally {
      release(cwd)
      await new Promise((resolve) => setImmediate(resolve))
    }
    expect((await discoverClaudeSkills({ cwd, home })).sources.length).toBeGreaterThan(0)
  })
  it('parses scalar and folded metadata without YAML evaluation or body fallback', () => {
    expect(
      skillFrontmatter("---\nname: test\ndescription: 'It''s useful'\n---\nname: body", 'fallback')
    ).toEqual({ name: 'test', description: "It's useful" })
    expect(skillFrontmatter('---\nname: bad name\n---', 'fallback')).toBeNull()
    expect(skillFrontmatter('---\nname: unfinished', 'fallback')).toBeNull()
    expect(skillFrontmatter('BODY ONLY', 'fallback')).toEqual({
      name: 'fallback',
      description: null
    })
  })
})
describe('Codex skill metadata', () => {
  it('converts app-server schemas, filters disabled/foreign entries and does not open paths', () => {
    const result = codexSkillDiscovery(
      {
        data: [
          {
            cwd,
            skills: [
              {
                name: 'review',
                description: 'Long',
                shortDescription: 'Short',
                path: 'C:\\skills\\review\\SKILL.md',
                scope: 'user',
                enabled: true
              },
              { name: 'off', path: 'C:\\skills\\off\\SKILL.md', enabled: false },
              { name: 'relative', path: '../secret', enabled: true }
            ]
          },
          { cwd: 'foreign', skills: [{ name: 'foreign', path: '/tmp/SKILL.md', enabled: true }] }
        ]
      },
      cwd,
      () => 42
    )
    expect(result.scannedAt).toBe(42)
    expect(result.skills).toHaveLength(1)
    expect(result.skills[0]).toMatchObject({
      name: 'review',
      description: 'Short',
      providers: ['codex'],
      sourceKind: 'home',
      rootPath: 'C:\\skills',
      updatedAt: null
    })
    expect(result.sources[0]).toMatchObject({ owner: 'codex', exists: true })
  })
})
