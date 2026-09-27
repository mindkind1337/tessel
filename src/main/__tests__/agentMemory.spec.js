// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { withRule, writeBoardRule, memoryFile, RULE_START, RULE_END, BOARD_RULE } from '../agentMemory'

let home
beforeEach(() => {
  home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-memory-'))
})
afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true })
})

describe('the task board rule in agents memory files', () => {
  it('keeps the user text, adds its part once, replaces it in place after', () => {
    const mine = '# My rules\n\nAlways answer in French.\n'
    const once = withRule(mine)
    expect(once.startsWith(mine.trimEnd())).toBe(true)
    expect(once).toContain(`${RULE_START}\n${BOARD_RULE}\n${RULE_END}`)
    expect(withRule(once)).toBe(once) // nothing changes the second time
    const updated = withRule(once + '\nMore of mine.\n', 'NEW RULE')
    expect(updated).toContain(`${RULE_START}\nNEW RULE\n${RULE_END}`)
    expect(updated).toContain('More of mine.')
    expect(updated.split(RULE_START)).toHaveLength(2)
    expect(withRule('')).toBe(`${RULE_START}\n${BOARD_RULE}\n${RULE_END}\n`)
  })

  it('writes each agent its own file, only when it changes', () => {
    const r1 = writeBoardRule('claude', home)
    expect(r1).toEqual({ changed: true, file: join(home, '.claude', 'CLAUDE.md') })
    expect(writeBoardRule('claude', home).changed).toBe(false)
    fs.writeFileSync(join(home, '.claude', 'CLAUDE.md'), 'Mine first.\n' + fs.readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8'))
    expect(writeBoardRule('claude', home).changed).toBe(false)
    expect(fs.readFileSync(join(home, '.claude', 'CLAUDE.md'), 'utf8').startsWith('Mine first.')).toBe(true)
    expect(memoryFile('codex', home, {})).toBe(join(home, '.codex', 'AGENTS.md'))
    expect(memoryFile('gemini', home, {})).toBe(join(home, '.gemini', 'GEMINI.md'))
    expect(memoryFile('qwen', home, {})).toBe(join(home, '.qwen', 'QWEN.md'))
    expect(memoryFile('opencode', home, {})).toBe(join(home, '.config', 'opencode', 'AGENTS.md'))
    expect(memoryFile('cline', home, {})).toBe(join(home, 'Documents', 'Cline', 'Rules', 'tessel-task-board.md'))
    expect(writeBoardRule('aider', home)).toEqual({ changed: false, file: null })
  })
})
