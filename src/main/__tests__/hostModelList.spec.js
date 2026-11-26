// The models an agent on an SSH host can run (hostModelList.js): Codex's own
// catalog there, read over the connection, kept per host and account folder.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createHostModelLister, loadHostModelLists, hostModelKey, MAX_HOST_LISTS } from '../hostModelList'

const catalog = (slugs) =>
  JSON.stringify({
    fetched_at: '2026-11-26T11:19:27Z',
    client_version: '0.160.1',
    models: slugs.map((slug) => ({ slug, display_name: slug.toUpperCase(), visibility: slug.startsWith('hidden') ? 'hide' : 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }], default_reasoning_level: 'medium' }))
  })

let dir
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-hostmodels-'))
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('an SSH host’s own model list', () => {
  it('reads Codex’s catalog there, per host and account folder, and keeps it', async () => {
    const read = vi.fn(async (_hostId, { account }) => ({ ok: true, text: catalog(account ? ['gpt-6-sol'] : ['gpt-6-astra', 'gpt-5.6-sol', 'hidden-one']) }))
    const lister = createHostModelLister(dir, { read, now: () => 1000 })
    const res = await lister.refresh({ hostId: 'ssh-box', agent: 'codex', account: null })
    expect(res).toMatchObject({ ok: true, key: 'ssh-box|codex|', fetchedAt: 1000 })
    // What Codex hides from its own picker is left out.
    expect(res.models.map((m) => m.id)).toEqual(['gpt-6-astra', 'gpt-5.6-sol'])
    expect(res.models[0]).toMatchObject({ label: 'GPT-6-ASTRA', effortLevels: ['low', 'medium'], defaultEffort: 'medium' })
    const other = await lister.refresh({ hostId: 'ssh-box', agent: 'codex', account: 'ab12' })
    expect(read).toHaveBeenLastCalledWith('ssh-box', { account: 'ab12' })
    expect(other.key).toBe(hostModelKey('ssh-box', 'codex', 'ab12'))
    expect(Object.keys(lister.list()).sort()).toEqual(['ssh-box|codex|', 'ssh-box|codex|ab12'])
    // On disk for the next start.
    expect(loadHostModelLists(dir)['ssh-box|codex|ab12'].models.map((m) => m.id)).toEqual(['gpt-6-sol'])
  })

  it('a host without the file, not connected, or an answer that is not a catalog changes nothing', async () => {
    let answer = { ok: true, text: catalog(['gpt-6-sol']) }
    const lister = createHostModelLister(dir, { read: async () => answer })
    await lister.refresh({ hostId: 'ssh-box', agent: 'codex' })
    for (const [next, reason] of [
      [{ ok: true, text: '' }, 'missing'],
      [{ ok: false, notConnected: true }, 'not-connected'],
      [{ ok: false, error: 'rc 1' }, 'failed'],
      [{ ok: true, text: 'Welcome to box' }, 'empty'],
      [{ ok: true, text: '{"models":[]}' }, 'empty']
    ]) {
      answer = next
      expect(await lister.refresh({ hostId: 'ssh-box', agent: 'codex' })).toEqual({ ok: false, reason })
    }
    expect(lister.list()['ssh-box|codex|'].models.map((m) => m.id)).toEqual(['gpt-6-sol'])
  })

  it('asks only for Codex, a saved host id and an account folder id; one read at a time per list', async () => {
    let done
    const read = vi.fn(() => new Promise((r) => (done = r)))
    const lister = createHostModelLister(dir, { read })
    for (const q of [{ hostId: 'ssh-box', agent: 'claude' }, { hostId: 'a b; rm', agent: 'codex' }, { hostId: 'ssh-box', agent: 'codex', account: '../x' }, null])
      expect(await lister.refresh(q)).toEqual({ ok: false, reason: 'unsupported' })
    expect(read).not.toHaveBeenCalled()
    const a = lister.refresh({ hostId: 'ssh-box', agent: 'codex' })
    const b = lister.refresh({ hostId: 'ssh-box', agent: 'codex' })
    expect(read).toHaveBeenCalledTimes(1)
    done({ ok: true, text: catalog(['gpt-6-sol']) })
    expect((await a).ok && (await b).ok).toBe(true)
  })

  it('keeps the newest lists only, and ignores a damaged file', async () => {
    let t = 0
    const lister = createHostModelLister(dir, { read: async () => ({ ok: true, text: catalog(['gpt-6-sol']) }), now: () => ++t })
    for (let i = 0; i < MAX_HOST_LISTS + 3; i++) await lister.refresh({ hostId: `ssh-h${i}`, agent: 'codex' })
    const keys = Object.keys(lister.list())
    expect(keys).toHaveLength(MAX_HOST_LISTS)
    expect(keys).not.toContain('ssh-h0|codex|')
    fs.writeFileSync(join(dir, 'agent-host-models.json'), '{"evil key":{"models":[{"id":"x"}]},"ssh-a|codex|":{"models":"no"}')
    expect(loadHostModelLists(dir)).toEqual({})
  })
})
