import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { titleFromPrompt, claudeSessionTitle, codexSessionTitle } from '../sessionTitle'

const ID = '11111111-2222-4333-8444-555555555555'

describe('titles from a prompt', () => {
  it('keeps the first clause without filler, links or markdown', () => {
    expect(titleFromPrompt('Can you please fix the login bug? It fails on Windows.')).toBe('Fix the login bug')
    expect(titleFromPrompt('issue #12: **add** dark mode to settings')).toBe('Add dark mode to settings')
    expect(titleFromPrompt("Let's refactor https://x.y/z the pty host")).toBe('Refactor the pty host')
    expect(titleFromPrompt('reprends toutes les fonctionnalités de celui-ci stp')).toBe('Reprends toutes les fonctionnalités de')
    expect(titleFromPrompt('   ')).toBe('')
  })
})

describe('a conversation’s own title', () => {
  let home
  beforeEach(() => {
    home = fs.mkdtempSync(join(os.tmpdir(), 'tessel-title-'))
  })
  afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

  it('Claude: first real message, then its generated title, then a rename; read as the file grows', async () => {
    const dir = join(home, '.claude', 'projects', 'C--proj')
    fs.mkdirSync(dir, { recursive: true })
    const f = join(dir, `${ID}.jsonl`)
    const line = (o) => JSON.stringify(o) + '\n'
    fs.writeFileSync(
      f,
      line({ type: 'user', message: { content: '<command-name>/clear</command-name>' } }) +
        line({ type: 'user', message: { content: [{ type: 'text', text: 'Please add a usage report. With costs.' }] } })
    )
    expect(await claudeSessionTitle(ID, home)).toBe('Add a usage report')
    fs.appendFileSync(f, line({ type: 'ai-title', aiTitle: 'Usage report with costs' }))
    expect(await claudeSessionTitle(ID, home)).toBe('Usage report with costs')
    fs.appendFileSync(f, line({ type: 'custom-title', customTitle: 'Usage v2' }) + '{"type":"ai-ti')
    expect(await claudeSessionTitle(ID, home)).toBe('Usage v2')
    expect(await claudeSessionTitle('not-an-id', home)).toBe('')
    expect(await claudeSessionTitle('99999999-2222-4333-8444-555555555555', home)).toBe('')
  })

  it('Codex: the latest thread name for the id', () => {
    const codexHome = join(home, '.codex')
    fs.mkdirSync(codexHome)
    fs.writeFileSync(
      join(codexHome, 'session_index.jsonl'),
      `{"id":"${ID}","thread_name":"First"}\n{"id":"other","thread_name":"X"}\n{"id":"${ID}","thread_name":"Renamed"}\n`
    )
    expect(codexSessionTitle(ID, codexHome)).toBe('Renamed')
    expect(codexSessionTitle(ID, join(home, 'none'))).toBe('')
  })
})
