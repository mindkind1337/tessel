// @vitest-environment node
// Muse Code's sub-agents in the pane's list: the child sessions its hooks
// announced (noted by the hook script per top-level session), each read from
// its own log inside its parent's session folder (subagent/<id>/), never the
// logs Muse's background observers write beside them. Fixtures shaped like
// Muse's logs, in a temporary home; the hook script run as Muse would run it.
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join, resolve, sep } from 'path'
import { spawn } from 'child_process'
import { museSubagents } from '../agentChildren'
import { museSessionsDir } from '../museSessions'
import { uuid7, line, museLog, writeMuseSession } from './fixtures/museLog'

const script = join(__dirname, '..', 'teamMcp', 'server.cjs')
let dir, home, sessions
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-muse-children-'))
  home = join(dir, 'home')
  sessions = join(dir, 'sessions')
  fs.mkdirSync(home)
})
afterEach(() => {
  const target = resolve(dir)
  if (!target.startsWith(resolve(os.tmpdir()) + sep) || !target.includes('tessel-muse-children-')) throw new Error('Unsafe fixture path')
  fs.rmSync(target, { recursive: true, force: true })
})
function runHook(event, payload, env) {
  return new Promise((done, fail) => {
    const clean = { ...process.env }
    for (const key of Object.keys(clean)) if (/^(TESSEL_|MUSE_)/i.test(key)) delete clean[key]
    const child = spawn(process.execPath, [script, '--hook', '--agent=muse', `--event=${event}`], { cwd: dir, windowsHide: true, env: { ...clean, ...env } })
    const timer = setTimeout(() => {
      child.kill()
      fail(new Error('Hook fixture timed out'))
    }, 8000)
    child.on('error', fail)
    child.on('close', (code) => {
      clearTimeout(timer)
      done(code)
    })
    child.stdin.end(JSON.stringify({ hook_event_name: event, cwd: dir, model: 'muse-spark-1.3', ...payload }))
  })
}

const t0 = Date.parse('2026-10-15T14:00:00Z')
const top = uuid7(t0)
const explorer = uuid7(t0 + 60000, '111111111111')
const nested = uuid7(t0 + 90000, '222222222222')
const observer = uuid7(t0 + 61000, '333333333333')
function childLog(parentFolder, id, lines) {
  const folder = join(parentFolder, 'subagent', id)
  fs.mkdirSync(folder, { recursive: true })
  fs.writeFileSync(join(folder, 'session.jsonl'), lines.join('\n') + '\n')
  return folder
}

describe('Muse Code sub-agents', () => {
  it('the hook script notes each child its SubagentStart and SubagentStop announce (ids, a name and times only)', async () => {
    const env = { TESSEL_PANE_ID: 'pane-muse', TESSEL_SESSIONS_DIR: sessions, TESSEL_AGENT_PROVIDER: 'muse', MUSE_SESSION_ID: top, MUSE_THREAD_ID: top }
    expect(await runHook('SubagentStart', { session_id: top, turn_id: 't1', subagent_id: 'explorer', child_session_id: explorer, prompt: 'PRIVATE' }, env)).toBe(0)
    const file = join(sessions, 'muse-children', top, `${explorer}.json`)
    const started = JSON.parse(fs.readFileSync(file, 'utf8'))
    expect(started).toEqual({ startedAt: expect.any(Number), name: 'explorer' })
    expect(await runHook('SubagentStop', { session_id: top, turn_id: 't1', subagent_id: 'explorer', child_session_id: explorer, last_assistant_message: 'PRIVATE' }, env)).toBe(0)
    expect(JSON.parse(fs.readFileSync(file, 'utf8'))).toEqual({ startedAt: started.startedAt, name: 'explorer', stoppedAt: expect.any(Number) })
    expect(fs.readFileSync(file, 'utf8')).not.toContain('PRIVATE')
    // Not a session id: nothing noted.
    await runHook('SubagentStart', { session_id: top, child_session_id: '../../x' }, env)
    expect(fs.readdirSync(join(sessions, 'muse-children', top))).toEqual([`${explorer}.json`])
    // Its background observers (announced the same way, nearly every turn): never noted.
    await runHook('SubagentStart', { session_id: top, turn_id: 't2', subagent_id: 'skill-reminder', child_session_id: observer }, env)
    expect(fs.readdirSync(join(sessions, 'muse-children', top))).toEqual([`${explorer}.json`])
  })

  it('listed from their own logs: task, model, effort, tokens, done or running; an observer’s log never', () => {
    const parent = join(writeMuseSession(museSessionsDir(home), top, museLog()), '..')
    const explorerDir = childLog(parent, explorer, [
      line('runtime.session.metadata', { record: { workspace_root: 'C:\\p', model_id: 'muse-spark-1.3' } }, '2026-10-15T14:01:00Z'),
      line('runtime.user_intent.accepted', { refill_blocks: [{ type: 'text', text: 'Find every caller of refreshToken' }] }, '2026-10-15T14:01:00.100Z'),
      line('run.model.configured', { record: { model_id: 'muse-spark-1.3', reasoning_effort: 'medium' } }, '2026-10-15T14:01:00.200Z'),
      line('runtime.session', { event: { kind: 'model_completed', model: 'muse-spark-1.3', usage: { input_tokens: 9000, output_tokens: 300 } } }, '2026-10-15T14:01:40Z')
    ])
    childLog(explorerDir, nested, [line('runtime.user_intent.accepted', { refill_blocks: [{ type: 'text', text: 'Read auth.ts' }] }, '2026-10-15T14:01:30Z')])
    childLog(parent, observer, [line('runtime.user_intent.accepted', { refill_blocks: [{ type: 'text', text: 'memory recall' }] }, '2026-10-15T14:01:01Z')])
    const reg = join(sessions, 'muse-children', top)
    fs.mkdirSync(reg, { recursive: true })
    fs.writeFileSync(join(reg, `${explorer}.json`), JSON.stringify({ startedAt: t0 + 60000, name: 'explorer', stoppedAt: t0 + 100000 }))
    fs.writeFileSync(join(reg, `${nested}.json`), JSON.stringify({ startedAt: t0 + 90000 }))
    // An observer noted by an older hook script: still not a sub-agent.
    fs.writeFileSync(join(reg, `${observer}.json`), JSON.stringify({ startedAt: t0 + 61000, name: 'goal-reminder' }))
    const now = Date.parse('2026-10-15T14:02:00Z')
    const rows = museSubagents(top, { sessionsDir: sessions, home, now })
    expect(rows.map((r) => r.id)).toEqual([nested, explorer])
    expect(rows[1]).toMatchObject({ type: 'explorer', title: 'Find every caller of refreshToken', state: 'done', model: 'muse-spark-1.3', effort: 'medium', tokens: 9300, startedAt: Date.parse('2026-10-15T14:01:00Z') })
    expect(rows[0]).toMatchObject({ type: 'subagent', title: 'Read auth.ts' })
    expect(rows.some((r) => r.id === observer)).toBe(false)
  })

  it('nothing noted, or not a session id: none', () => {
    writeMuseSession(museSessionsDir(home), top, museLog())
    expect(museSubagents(top, { sessionsDir: sessions, home })).toEqual([])
    expect(museSubagents('../x', { sessionsDir: sessions, home })).toEqual([])
    expect(museSubagents(top, { sessionsDir: null, home })).toEqual([])
  })
})
