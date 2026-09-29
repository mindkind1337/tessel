// @vitest-environment node
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { claudeCommands, normalizeCommands } from '../commands.js'
const recorded = fs
  .readFileSync(path.join(__dirname, 'fixtures/claude-real-frames.jsonl'), 'utf8')
  .trim()
  .split('\n')
  .map((line) => JSON.parse(line))
describe('provider command catalogs', () => {
  it('combines recorded initialize help with system/init classifications without treating agents as skills', () => {
    const init = recorded.find((row) => row.label === 'initialize-response').frame.response.response
    const first = claudeCommands(init)
    expect(first.find((row) => row.name === 'design')).toMatchObject({
      argumentHint: 'consent | revoke',
      kindUnspecified: true
    })
    expect(first.some((row) => row.name === 'claude')).toBe(false)
    const system = recorded.find((row) => row.label === 'system-init').frame
    const next = claudeCommands(system, first)
    expect(next.find((row) => row.name === 'design')).toMatchObject({
      argumentHint: 'consent | revoke',
      kind: 'skill'
    })
    expect(next.find((row) => row.name === 'design').kindUnspecified).toBeUndefined()
    expect(next.find((row) => row.name === 'compact')).toMatchObject({
      kind: 'command',
      kindUnspecified: true
    })
    expect(next.some((row) => system.terminal_slash_commands.includes(row.name))).toBe(false)
    expect(claudeCommands({ slash_commands: [], skills: [] }, next)).toEqual([])
  })
  it('bounds, deduplicates and rejects unsafe or malformed metadata', () => {
    const rows = normalizeCommands([
      null,
      {},
      { name: '/valid', description: 'a'.repeat(900), argumentHint: '\u202ehelp' },
      'valid',
      'bad name',
      'bad\nname',
      'a'.repeat(129),
      ...Array.from({ length: 700 }, (_, i) => `skill-${i}`)
    ])
    expect(rows).toHaveLength(512)
    expect(rows[0]).toMatchObject({
      name: 'valid',
      description: 'a'.repeat(512),
      argumentHint: ' help'
    })
    expect(rows.some((row) => row.name.includes('bad'))).toBe(false)
  })
})
