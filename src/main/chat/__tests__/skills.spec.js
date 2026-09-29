// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { discoverClaudeSkills, codexSkillDiscovery, skillFrontmatter } from '../skills.js'
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
    const timed = await discoverClaudeSkills({
      cwd,
      home,
      limits: { time: 15 },
      io: { ...fs, realpath: () => new Promise(() => {}) }
    })
    expect(timed.skills).toEqual([])
    expect(timed.sources.every((source) => source.skippedReason === 'unavailable')).toBe(true)
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
