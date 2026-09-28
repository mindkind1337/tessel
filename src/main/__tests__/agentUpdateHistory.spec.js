// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createUpdateHistory, cleanEntry, MAX_ENTRIES } from '../agentUpdateHistory'
import { createInstallLogs } from '../installLog'

let dir, file
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-updhist-'))
  file = join(dir, 'agent-update-history.json')
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

const entry = (i, extra = {}) => ({ agentId: i % 2 ? 'codex' : 'claude', name: 'X', at: 1000 + i, ok: true, kind: 'ok', from: '1.0.0', to: '1.1.0', version: '1.1.0', ...extra })

describe('agent update history', () => {
  it('keeps the newest attempts first, at most 20, and each agent’s last result', () => {
    const h = createUpdateHistory({ file })
    for (let i = 0; i < 30; i++) h.add(entry(i))
    const got = h.get()
    expect(got.entries).toHaveLength(MAX_ENTRIES)
    expect(got.entries[0].at).toBe(1029)
    expect(got.last.codex.at).toBe(1029)
    expect(got.last.claude.at).toBe(1028)
  })

  it('persists across restarts (userData file) and survives a broken file', () => {
    const h = createUpdateHistory({ file })
    h.add(entry(1, { ok: false, kind: 'in-use', detail: 'npm error code EBUSY', file: 'C:\\logs\\installs\\Update-Codex.log' }))
    const again = createUpdateHistory({ file }).get()
    expect(again.entries).toHaveLength(1)
    expect(again.last.codex).toMatchObject({ ok: false, kind: 'in-use', detail: 'npm error code EBUSY', via: 'background' })
    fs.writeFileSync(file, '{ not json')
    expect(createUpdateHistory({ file }).get()).toEqual({ entries: [], last: {} })
  })

  it('bounds what a hand-edited file can hold', () => {
    fs.writeFileSync(
      file,
      JSON.stringify({ entries: Array.from({ length: 100 }, (_, i) => entry(i, { detail: 'x'.repeat(5000), kind: 'weird' })), last: { claude: entry(2), codex: entry(2) } })
    )
    const got = createUpdateHistory({ file }).get()
    expect(got.entries).toHaveLength(MAX_ENTRIES)
    expect(got.entries[0].detail).toHaveLength(300)
    expect(got.entries[0].kind).toBe('ok') // an unknown kind: from ok
    expect(Object.keys(got.last)).toEqual(['claude']) // codex's entry is another agent's
  })

  it('cleanEntry drops what is not an entry', () => {
    expect(cleanEntry(null)).toBeNull()
    expect(cleanEntry({ agentId: 'x' })).toBeNull()
    expect(cleanEntry({ agentId: 'x', at: 5, ok: false })).toMatchObject({ kind: 'failed', via: 'background', auto: false })
  })
})

describe('install log for updates', () => {
  it('end() closes a run without a pane; an agent update is told back with its result', () => {
    const results = []
    const logs = createInstallLogs({ dir, notify: (r) => results.push(r) })
    const { file: f } = logs.start({ paneId: 'p1', name: 'Update Codex', shell: 'powershell', steps: ['npm i -g x'], agentUpdate: { agentId: 'codex', from: '1.0.0', to: '1.1.0' } })
    logs.onData('p1', 'npm error code EBUSY\n')
    logs.onExit('p1', 1)
    expect(results[0]).toMatchObject({ ok: false, locked: true, agentUpdate: { agentId: 'codex', from: '1.0.0', to: '1.1.0' }, file: f })
    logs.start({ paneId: 'bg', name: 'Update X', shell: 'background', steps: ['npm i -g x'] })
    logs.end('bg', true, '')
    expect(results[1]).toMatchObject({ paneId: 'bg', ok: true })
    expect(results[1].agentUpdate).toBeUndefined()
  })
})
