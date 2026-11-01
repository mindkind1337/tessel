// Antigravity CLI on an SSH host: a pane is matched to its conversation with the host's own files.
import { describe, it, expect, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { AGY_FILES, AGY_HEAD_BYTES, AGY_OUTPUT_CAP, agyHostSessions, parseAgyFind } from '../remoteAgent/antigravityOnHost'
import { pickSession } from '../agentResume'
import { createRemoteSession, FUNCTIONS, sessionArgs } from '../remoteShell'
import { fakeSshLaunch } from './fixtures/fakeSsh'

const ID_A = '11111111-1111-4111-8111-111111111111'
const ID_B = '22222222-2222-4222-8222-222222222222'
const T0 = Date.parse('2026-11-01T20:00:00Z')
const transcript = (prompt, at = T0) => `${JSON.stringify({ source: 'USER_EXPLICIT', type: 'USER_INPUT', content: `<USER_REQUEST>${prompt}</USER_REQUEST>`, created_at: new Date(at).toISOString() })}\n`
const line = (fields) => `${JSON.stringify(fields)}\n`

describe('reading what the helper sends', () => {
  const output = (files, history) => Buffer.concat([...files.flatMap(({ id, m, text }) => [Buffer.from(`@file ${id} ${m} ${Buffer.byteLength(text)}\n`), Buffer.from(text), Buffer.from('\n')]), ...(history === null ? [] : [Buffer.from(`@history ${Buffer.byteLength(history)}\n`), Buffer.from(history), Buffer.from('\n')])])

  it('files and history, whatever they hold, accents and line breaks too', () => {
    const parsed = parseAgyFind(output([{ id: ID_A, m: 1000, text: 'é\n@file evil 1 1\nx' }, { id: ID_B, m: 2000, text: 'b' }], 'hist é\n'))
    expect(parsed.files).toEqual([{ id: ID_A, mtimeMs: 1000000, head: 'é\n@file evil 1 1\nx' }, { id: ID_B, mtimeMs: 2000000, head: 'b' }])
    expect(parsed.history).toBe('hist é\n')
  })

  it('nothing, junk or a cut output: what came before it, never a throw', () => {
    expect(parseAgyFind(Buffer.alloc(0))).toEqual({ files: [], history: '' })
    expect(parseAgyFind('garbage\n')).toEqual({ files: [], history: '' })
    expect(parseAgyFind('@file ../../x 1 1\nx\n').files).toEqual([])
    const cut = Buffer.concat([output([{ id: ID_A, m: 1, text: 'a' }], null), Buffer.from(`@file ${ID_B} 1 500\nshort`)])
    expect(parseAgyFind(cut).files.map((f) => f.id)).toEqual([ID_A])
  })
})

describe('matching a pane to its conversation', () => {
  const CWD = '/home/me/project/[dev]'
  const files = [{ id: ID_A, mtimeMs: T0 + 5000, head: transcript('hello') }, { id: ID_B, mtimeMs: T0 + 6000, head: transcript('other', T0 + 1000) }]

  it('by the id history.jsonl names', () => {
    const rows = agyHostSessions({ files, history: line({ display: 'x', timestamp: T0, workspace: CWD, conversationId: ID_A }) })
    expect(rows.find((r) => r.id === ID_A).cwd).toBe(CWD)
    expect(rows.find((r) => r.id === ID_B).cwd).toBe('')
    expect(pickSession(rows, { cwd: CWD, since: T0 - 1000 })).toBe(ID_A)
  })

  it('by its first prompt, for a conversation with only one so far', () => {
    const rows = agyHostSessions({ files, history: line({ display: 'hello', timestamp: T0 + 500, workspace: CWD }) })
    expect(pickSession(rows, { cwd: CWD, since: T0 - 1000 })).toBe(ID_A)
  })

  it('never another folder\'s, an older one, or one another pane has', () => {
    const rows = agyHostSessions({ files, history: line({ display: 'x', timestamp: T0, workspace: '/elsewhere', conversationId: ID_A }) })
    expect(pickSession(rows, { cwd: CWD, since: T0 - 1000 })).toBeNull()
    const here = agyHostSessions({ files, history: line({ display: 'x', timestamp: T0, workspace: CWD, conversationId: ID_A }) })
    expect(pickSession(here, { cwd: CWD, since: T0 + 3_600_000 })).toBeNull()
    expect(pickSession(here, { cwd: CWD, since: T0 - 1000, exclude: [ID_A] })).toBeNull()
  })
})

describe('on a real shell', () => {
  let dir
  let session = null
  afterEach(() => {
    if (session) session.close('done')
    session = null
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  async function start() {
    const launch = fakeSshLaunch({ home: dir })
    session = createRemoteSession({ file: launch.file, args: sessionArgs(launch.args), spawnImpl: launch.spawnImpl })
    await session.start()
  }
  const brain = (id) => join(dir, '.gemini', 'antigravity-cli', 'brain', id, '.system_generated', 'logs')
  function conversation(id, text, secondsAgo = 0) {
    fs.mkdirSync(brain(id), { recursive: true })
    const file = join(brain(id), 'transcript.jsonl')
    fs.writeFileSync(file, text)
    const when = Date.now() / 1000 - secondsAgo
    fs.utimesSync(file, when, when)
  }
  const nowSeconds = () => Math.floor(Date.now() / 1000)

  it('the helpers are ones Tessel may call', () => {
    expect(FUNCTIONS.has('__t_agyfind')).toBe(true)
    expect(FUNCTIONS.has('__t_agyhas')).toBe(true)
  })

  it('sends the recent conversations, newest first, and the history; an old one and a bad name stay out', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agy-'))
    conversation(ID_A, transcript('recent é', Date.now()), 10)
    conversation(ID_B, transcript('newest', Date.now()), 1)
    conversation('33333333-3333-4333-8333-333333333333', transcript('old'), 7200)
    conversation('bad name', transcript('bad'), 1)
    fs.writeFileSync(join(dir, '.gemini', 'antigravity-cli', 'history.jsonl'), line({ display: 'recent é', workspace: '/w', conversationId: ID_A }))
    await start()
    const r = await session.run('__t_agyfind', [String(nowSeconds() - 3600), String(AGY_FILES), String(AGY_HEAD_BYTES), '262144'], { cap: AGY_OUTPUT_CAP })
    expect(r.rc).toBe(0)
    const parsed = parseAgyFind(r.out)
    expect(parsed.files.map((f) => f.id)).toEqual([ID_B, ID_A])
    expect(parsed.files[1].head).toContain('recent é')
    expect(parsed.history).toContain(ID_A)
    expect(agyHostSessions(parsed).find((x) => x.id === ID_A).cwd).toBe('/w')
  }, 30000)

  it('a long transcript sends its start only; a long history its end', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agy-'))
    conversation(ID_A, `${transcript('first', Date.now())}${'x'.repeat(40000)}`)
    fs.writeFileSync(join(dir, '.gemini', 'antigravity-cli', 'history.jsonl'), `${'y'.repeat(4000)}\nEND`)
    await start()
    const r = await session.run('__t_agyfind', ['0', '5', '1000', '100'], { cap: AGY_OUTPUT_CAP })
    const parsed = parseAgyFind(r.out)
    expect(parsed.files[0].head.length).toBe(1000)
    expect(parsed.files[0].head).toContain('first')
    expect(parsed.history.length).toBe(100)
    expect(parsed.history.endsWith('END')).toBe(true)
  }, 30000)

  it('a link in place of a transcript or the history is not read', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agy-'))
    conversation(ID_A, transcript('x', Date.now()))
    const secret = join(dir, 'secret.txt')
    fs.writeFileSync(secret, 'SECRET')
    let linked = true
    try {
      fs.mkdirSync(brain(ID_B), { recursive: true })
      fs.symlinkSync(secret, join(brain(ID_B), 'transcript.jsonl'))
      fs.symlinkSync(secret, join(dir, '.gemini', 'antigravity-cli', 'history.jsonl'))
    } catch {
      linked = false // no right to make links here
    }
    await start()
    const r = await session.run('__t_agyfind', ['0', '5', '1000', '100'], { cap: AGY_OUTPUT_CAP })
    if (linked) expect(r.out.toString('utf8')).not.toContain('SECRET')
    expect(parseAgyFind(r.out).files.map((f) => f.id)).toContain(ID_A)
  }, 30000)

  it('whether a conversation is there; a bad id is refused', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agy-'))
    conversation(ID_A, transcript('x'))
    await start()
    expect((await session.run('__t_agyhas', [ID_A])).rc).toBe(0)
    expect((await session.run('__t_agyhas', [ID_B])).rc).toBe(91)
    expect((await session.run('__t_agyhas', ['../../etc'])).rc).toBe(90)
  }, 30000)

  it('no Antigravity on this host: nothing, and no error', async () => {
    dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-agy-'))
    await start()
    const r = await session.run('__t_agyfind', ['0', '5', '1000', '100'], { cap: AGY_OUTPUT_CAP })
    expect(r.rc).toBe(91)
    expect(parseAgyFind(r.out)).toEqual({ files: [], history: '' })
  }, 30000)
})
