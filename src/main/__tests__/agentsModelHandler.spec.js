// The agents:model handler (taken from index.js): a Codex pane on a managed
// account reads that account's Codex home, never a path from the window, and
// never the system's ~/.codex when the account can't be read.
import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import vm from 'node:vm'
import { join } from 'node:path'

const main = fs.readFileSync(join(__dirname, '..', 'index.js'), 'utf8').replace(/\r\n/g, '\n')
const start = main.indexOf("ipcMain.handle('agents:model',")
const handlerSource = main.slice(start, main.indexOf('\n})\n', start) + 4)

function harness(roots) {
  const reads = []
  const calls = []
  const handlers = {}
  vm.runInNewContext(handlerSource, {
    ipcMain: { handle: (k, v) => (handlers[k] = v) },
    remoteHosts: { get: () => null },
    remoteModels: {},
    remoteAgentModel: async () => null,
    accountSessions: { roots },
    os: { homedir: () => '/home/me' },
    sessionLister: { call: async (...args) => (calls.push(args), { model: 'from-worker', effort: null, source: 'session' }) },
    agentModelLive: async (q, home, fetchImpl, read) => {
      reads.push(q)
      // The files are read through the session list's process (read).
      const viaWorker = await read(q, home)
      return { model: q.codexDir ? 'gpt-account' : 'gpt-system', effort: 'low', source: 'session', viaWorker }
    }
  })
  return { call: (q) => handlers['agents:model']({}, q), reads, calls }
}

describe('agents:model handler', () => {
  it("reads a managed Codex account's own home, never a folder sent by the window", async () => {
    const h = harness(async () => ({ codex: 'C:\\accounts\\one\\home' }))
    expect(await h.call({ agentId: 'codex', accountId: 'one', codexDir: 'C:\\elsewhere' })).toMatchObject({ model: 'gpt-account' })
    expect(h.reads[0].codexDir).toBe('C:\\accounts\\one\\home')
  })

  it("an account that can't be read (removed meanwhile): the pane keeps what it showed, the system's ~/.codex is never read", async () => {
    for (const roots of [async () => null, async () => ({}), async () => Promise.reject(new Error('unreadable'))]) {
      const h = harness(roots)
      expect(await h.call({ agentId: 'codex', accountId: 'gone' })).toEqual({ keep: true })
      expect(h.reads).toEqual([])
    }
  })

  it('a pane on the system login reads the system files, as before', async () => {
    const h = harness(async () => {
      throw new Error('not asked')
    })
    expect(await h.call({ agentId: 'codex', codexDir: 'C:\\elsewhere' })).toMatchObject({ model: 'gpt-system' })
    expect(h.reads[0]).not.toHaveProperty('codexDir')
  })

  it("reads the model files in the session list's process, never on the main thread (it held it 3.5 s)", async () => {
    const h = harness(async () => null)
    const res = await h.call({ agentId: 'claude', sessionId: 's1' })
    expect(h.calls).toEqual([['agentModel', { agentId: 'claude', sessionId: 's1' }, '/home/me']])
    expect(res.viaWorker).toMatchObject({ model: 'from-worker' })
  })
})
