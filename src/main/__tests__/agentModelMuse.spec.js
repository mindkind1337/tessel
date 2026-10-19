// @vitest-environment node
// The model and effort a Muse Code pane runs, as the pane header reads them:
// its session log (fixtures shaped like Muse's session.jsonl), its
// --model / --reasoning-effort, then its settings, in a temporary home.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { agentModel, museEffortFromCommand, museSession, museSettingsModel } from '../agentModel'
import { museSessionsDir, museSettingsFile } from '../museSessions'
import { modelLabel } from '../../shared/modelLabel'
import { uuid7, line, museLog, writeMuseSession } from './fixtures/museLog'

let dir, home
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-model-'))
  home = join(dir, 'home')
  fs.mkdirSync(home)
})
afterEach(() => {
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-muse-model-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})
const id = uuid7(Date.parse('2026-10-15T12:00:00Z'))
const settings = (value) => {
  fs.mkdirSync(join(home, '.config', 'muse'), { recursive: true })
  fs.writeFileSync(museSettingsFile(home), JSON.stringify(value))
}

describe('a Muse Code pane: model and effort', () => {
  it('its session log: the turn’s model and effort, then a /models and an /effort in the session', () => {
    writeMuseSession(museSessionsDir(home), id, museLog())
    expect(agentModel({ agentId: 'muse', sessionId: id, command: 'muse --trust-workspace' }, home)).toMatchObject({ model: 'muse-spark-1.3', effort: 'high', source: 'session' })
    writeMuseSession(museSessionsDir(home), id, [
      ...museLog(),
      line('runtime.model_reconfigure.completed', { record: { effective: { model_id: 'muse-spark-1.3-contributor' } } }, '2026-10-15T14:10:00Z'),
      line('runtime.reasoning_effort_reconfigure.completed', { record: { reasoning_effort: 'max' } }, '2026-10-15T14:11:00Z')
    ])
    expect(agentModel({ agentId: 'muse', sessionId: id, command: 'muse --model muse-spark-1.2' }, home)).toMatchObject({ model: 'muse-spark-1.3-contributor', effort: 'max', source: 'session' })
  })

  it('a long log: the change in its tail, the effort its start names when the tail has none', () => {
    const filler = line('runtime.session', { event: { kind: 'tool_output', text: 'x'.repeat(4000) } }, '2026-10-15T14:01:00Z')
    writeMuseSession(museSessionsDir(home), id, [...museLog(), ...Array(120).fill(filler), line('runtime.model_reconfigure.completed', { record: { effective: { model_id: 'muse-wonder' } } }, '2026-10-15T15:00:00Z')])
    expect(museSession(id, home)).toMatchObject({ model: 'muse-wonder', effort: 'high' })
  })

  it('no log yet: --model and --reasoning-effort (or --effort), then the settings', () => {
    expect(agentModel({ agentId: 'muse', sessionId: id, command: 'muse --trust-workspace --model muse-spark-1.3 --reasoning-effort xhigh' }, home)).toEqual({ model: 'muse-spark-1.3', effort: 'xhigh', source: 'command' })
    expect(agentModel({ agentId: 'muse', command: 'muse --model=muse-spark-1.2 --effort low' }, home)).toEqual({ model: 'muse-spark-1.2', effort: 'low', source: 'command' })
    settings({ schema_version: 1, model: 'muse-spark-1.3', reasoning_effort: 'medium' })
    expect(agentModel({ agentId: 'muse', command: 'muse --trust-workspace' }, home)).toEqual({ model: 'muse-spark-1.3', effort: 'medium', source: 'settings' })
    expect(agentModel({ agentId: 'muse', command: 'muse --effort minimal' }, home)).toEqual({ model: 'muse-spark-1.3', effort: 'minimal', source: 'settings' })
  })

  it("Muse 1.4.10's settings: the effort it keeps per model (model_reasoning_efforts), for a log that names none", () => {
    // As Muse Code 1.4.10 writes it (its footer then reads "muse-wonder-1.0 · medium").
    settings({ schema_version: 1, provider: 'meta', model: 'muse-wonder-1.0', model_reasoning_efforts: { 'muse-wonder-1.0': 'medium', 'muse-spark-1.3': 'xhigh', 'bad id;': 'low', 'muse-spark-1.2': 'turbo' } })
    expect(agentModel({ agentId: 'muse', command: 'muse' }, home)).toEqual({ model: 'muse-wonder-1.0', effort: 'medium', source: 'settings' })
    // Its log names the model of each turn, never the effort.
    writeMuseSession(museSessionsDir(home), id, museLog({ model: 'muse-spark-1.3', effort: null }))
    expect(agentModel({ agentId: 'muse', sessionId: id, command: 'muse' }, home)).toMatchObject({ model: 'muse-spark-1.3', effort: 'xhigh', source: 'session' })
    // A model it keeps no effort for: none shown (never another model's).
    writeMuseSession(museSessionsDir(home), id, museLog({ model: 'muse-spark-1.2', effort: null }))
    expect(agentModel({ agentId: 'muse', sessionId: id, command: 'muse' }, home)).toMatchObject({ model: 'muse-spark-1.2', effort: null })
    expect(museSettingsModel(home).effortFor('bad id;')).toBe(null)
  })

  it('a log naming no effort takes the one it was launched with', () => {
    writeMuseSession(museSessionsDir(home), id, museLog({ effort: null }))
    expect(agentModel({ agentId: 'muse', sessionId: id, command: 'muse --reasoning-effort ultra' }, home)).toMatchObject({ model: 'muse-spark-1.3', effort: 'ultra', source: 'session' })
  })

  it('nothing known: nothing shown (never a guess)', () => {
    expect(agentModel({ agentId: 'muse', command: 'muse --trust-workspace' }, home)).toBe(null)
    settings({ schema_version: 1, model: { theme: 'dark' } })
    expect(museSettingsModel(home)).toBe(null)
  })

  it('only its eight tiers are an effort', () => {
    expect(museEffortFromCommand('muse --reasoning-effort none')).toBe('none')
    expect(museEffortFromCommand('muse --effort=ULTRA')).toBe('ultra')
    expect(museEffortFromCommand('muse --effort turbo')).toBe(null)
    expect(museEffortFromCommand('muse')).toBe(null)
  })

  it('its model ids as their product names in the header', () => {
    expect(modelLabel('muse-spark-1.3')).toBe('Muse Spark 1.3')
    expect(modelLabel('muse-spark-1.3-contributor')).toBe('Muse Spark 1.3 Contributor')
    expect(modelLabel('muse-wonder-full')).toBe('Muse Wonder Full')
  })
})
