// @vitest-environment node
// The OpenCode adapter against a fake `opencode serve` (fixtures/fake-opencode.cjs:
// an HTTP + SSE server that requires the password and replays the frames
// recorded from opencode 1.18.33). The real opencode is never run.
import { describe, it, expect, afterEach, vi } from 'vitest'

vi.setConfig({ testTimeout: 30000 })
import http from 'node:http'
import { mkdtempSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createOpencodeChat, buildOpencodeArgs, listenAddress, opencodeEnv, validOpencodeModel } from '../opencodeChat'

const FAKE = join(__dirname, 'fixtures', 'fake-opencode.cjs')
const open = []

function setup({ env: envExtra = {}, ...opts } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'tessel-fake-opencode-'))
  const logFile = join(dir, 'log.jsonl')
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_OC_LOG: logFile, OPENCODE_SERVER_PASSWORD: 'inherited', ...envExtra }
  const killed = []
  const chat = createOpencodeChat({
    exe: process.execPath,
    exeArgs: [FAKE],
    cwd: dir,
    env,
    killTree: async (child) => {
      killed.push(child.pid)
      child.kill()
    },
    ...opts
  })
  const events = []
  const emit = chat.emit.bind(chat)
  chat.emit = (type, payload) => {
    events.push({ type, ...payload })
    return emit(type, payload)
  }
  open.push(chat)
  const readLog = () => (existsSync(logFile) ? readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [])
  const reqs = (method, re) => readLog().filter((r) => r.t === 'req' && r.method === method && re.test(r.path))
  return { chat, events, readLog, reqs, dir, killed }
}

async function waitFor(fn, ms = 8000, label = 'condition') {
  const t0 = Date.now()
  for (;;) {
    const v = fn()
    if (v) return v
    if (Date.now() - t0 > ms) throw new Error('timeout waiting for ' + label)
    await new Promise((r) => setTimeout(r, 5))
  }
}
const ofType = (events, type) => events.filter((e) => e.type === type)

function rawGet(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method: 'GET', headers, agent: false }, (res) => {
      res.resume()
      resolve(res.statusCode)
    })
    req.on('error', reject)
    req.end()
  })
}

afterEach(async () => {
  while (open.length) await open.pop().close({ kill: true }).catch(() => {})
})

describe('OpenCode chat: start', () => {
  it('binds 127.0.0.1, keeps the password out of argv, proves the server is ours, records the version', async () => {
    const { chat, events, readLog, reqs } = setup()
    const r = await chat.start()
    expect(r).toMatchObject({ ok: true, info: { version: '1.18.33', resumed: false } })
    expect(r.info.sessionId).toMatch(/^ses_[A-Za-z0-9]{20,40}$/)
    expect(chat.sessionId).toBe(r.info.sessionId)
    const start = readLog().find((l) => l.t === 'start')
    expect(start.argv).toEqual(['serve', '--hostname', '127.0.0.1', '--port', '0'])
    expect(start.passwordInArgv).toBe(false)
    expect(start.autoupdate).toBe(null) // chatEnv sets it; the adapter does not add it
    const config = JSON.parse(start.config)
    expect(config).toMatchObject({ share: 'disabled', autoupdate: false })
    expect(Object.keys(config.agent)).toEqual(['build', 'plan', 'general', 'explore'])
    expect(JSON.parse(start.permissionEnv)['*']).toBe('ask')
    // Every request was authenticated, carried the folder and our Host,
    // except the one health check sent without the password on purpose.
    const all = readLog().filter((l) => l.t === 'req')
    expect(all.length).toBeGreaterThan(4)
    const unauthed = all.filter((l) => !l.authed)
    expect(unauthed.map((l) => l.path)).toEqual(['/global/health'])
    expect(all.every((l) => l.directory && /^127\.0\.0\.1:\d+$/.test(l.host))).toBe(true)
    expect(reqs('POST', /^\/session$/)[0].body.permission[0]).toEqual({ permission: '*', pattern: '*', action: 'ask' })
    expect(ofType(events, 'commands')[0].commands).toEqual([
      { name: 'review', kind: 'command', description: 'review changes', argumentHint: '$ARGUMENTS' },
      { name: 'xlsx', kind: 'skill', description: 'Spreadsheets' }
    ])
    // Without the password, the server answers nothing (401).
    const port = readLog().find((l) => l.t === 'listen').port
    expect(await rawGet(port, '/global/health')).toBe(401)
    expect(await rawGet(port, '/session', { authorization: 'Basic ' + Buffer.from('opencode:inherited').toString('base64') })).toBe(401)
  })

  it('refuses a server that is not on 127.0.0.1', async () => {
    const { chat, killed } = setup({ env: { FAKE_OC_HOST: '0.0.0.0' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(r.error).toMatch(/127\.0\.0\.1/)
    expect(killed.length).toBe(1)
  })

  it('refuses a server that does not know our password', async () => {
    const { chat } = setup({ env: { FAKE_OC_WRONG_PASSWORD: '1' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'failed' })
    expect(r.error).toMatch(/refused our password/)
  })

  it('times out when no address is printed', async () => {
    const { chat } = setup({ env: { FAKE_OC_SILENT: '1' }, timeouts: { start: 600 } })
    expect(await chat.start()).toMatchObject({ ok: false, code: 'timeout' })
  })

  it('refuses to open when a sub-agent could change files without asking (code posture)', async () => {
    const { chat } = setup({ env: { FAKE_OC_PERMISSIVE: '1' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'posture' })
    expect(r.error).toMatch(/agent general: edit allow/)
  })

  it('refuses when the session does not keep our rules', async () => {
    const { chat } = setup({ env: { FAKE_OC_DROP_SESSION_PERMISSION: '1' } })
    expect(await chat.start()).toMatchObject({ ok: false, code: 'posture' })
  })

  it('Yolo skips the Manual check (the session allows everything)', async () => {
    const { chat, reqs } = setup({ env: { FAKE_OC_PERMISSIVE: '1' }, permissions: 'yolo' })
    expect((await chat.start()).ok).toBe(true)
    expect(reqs('POST', /^\/session$/)[0].body.permission).toEqual([{ permission: '*', pattern: '*', action: 'allow' }])
  })

  it('restarts once with a user sub-agent added to the strict config', async () => {
    const { chat, readLog, killed } = setup({ env: { FAKE_OC_EXTRA_AGENT: 'reviewer' } })
    const r = await chat.start()
    expect(r.ok).toBe(true)
    const starts = readLog().filter((l) => l.t === 'start')
    expect(starts).toHaveLength(2)
    expect(Object.keys(JSON.parse(starts[1].config).agent)).toContain('reviewer')
    expect(killed.length).toBe(1) // the first server, by its PID
  })

  it('no provider: sign-in', async () => {
    const { chat, events } = setup({ env: { FAKE_OC_NO_PROVIDERS: '1' } })
    expect(await chat.start()).toMatchObject({ ok: false, code: 'signin' })
    expect(ofType(events, 'authError')).toHaveLength(1)
  })

  it('resumes a session of this folder, refuses an unknown one or another folder', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessel-oc-resume-'))
    const id = 'ses_resume0000000000000000001'
    const sessions = JSON.stringify([{ id, directory: dir.replace(/\\/g, '/') }, { id: 'ses_other00000000000000000001', directory: 'C:/elsewhere' }])
    const a = setup({ cwd: dir, sessionId: id, env: { FAKE_OC_SESSIONS: sessions } })
    const r = await a.chat.start()
    expect(r).toMatchObject({ ok: true, info: { sessionId: id, resumed: true } })
    expect(a.reqs('PATCH', /^\/session\/ses_resume/)[0].body.permission[0].action).toBe('ask')
    const b = setup({ sessionId: 'ses_unknown000000000000000001', env: { FAKE_OC_SESSIONS: sessions } })
    expect(await b.chat.start()).toMatchObject({ ok: false, code: 'failed' })
    const c = setup({ sessionId: 'ses_other00000000000000000001', env: { FAKE_OC_SESSIONS: sessions } })
    const rc = await c.chat.start()
    expect(rc).toMatchObject({ ok: false })
    expect(rc.error).toMatch(/another folder/)
  })

  it('validates its options (provider/model ids with one slash)', () => {
    expect(validOpencodeModel('opencode/nemotron-3.5-lightning-free')).toBe(true)
    expect(validOpencodeModel('openrouter/anthropic:claude')).toBe(true)
    expect(validOpencodeModel('nemotron')).toBe(false)
    expect(validOpencodeModel('a/b/c')).toBe(false)
    expect(validOpencodeModel('-x/y')).toBe(false)
    expect(() => createOpencodeChat({ exe: 'x', env: {}, cwd: 'C:/', model: 'bad' })).toThrow(/bad model/)
    expect(() => createOpencodeChat({ exe: 'x', env: {}, cwd: 'C:/', sessionId: 'nope' })).toThrow(/bad sessionId/)
    expect(buildOpencodeArgs({ exeArgs: ['a'] })).toEqual(['a', 'serve', '--hostname', '127.0.0.1', '--port', '0'])
    expect(listenAddress('opencode server listening on http://127.0.0.1:4096')).toEqual({ port: 4096 })
    expect(listenAddress('opencode server listening on http://0.0.0.0:4096')).toBe(null)
    expect(listenAddress('starting…')).toBe(undefined)
    const e = opencodeEnv({ opencode_server_password: 'x', OPENCODE_CONFIG_CONTENT: 'y', KEEP: 'k' }, { password: 'p', config: { a: 1 } })
    expect(e).toMatchObject({ KEEP: 'k', OPENCODE_SERVER_PASSWORD: 'p', OPENCODE_SERVER_USERNAME: 'opencode', OPENCODE_CONFIG_CONTENT: '{"a":1}' })
    expect(e.opencode_server_password).toBe(undefined)
  })
})

describe('OpenCode chat: turns', () => {
  it('a turn: delivered, streamed, ended once, with model and variant on the prompt', async () => {
    const { chat, events, reqs } = setup({ model: 'opencode/nemotron-3.5-lightning-free', effort: 'low' })
    expect((await chat.start()).ok).toBe(true)
    const r = await chat.send({ uuid: 'u-1', text: 'Reply with exactly: OK' })
    expect(r).toEqual({ ok: true, uuid: 'u-1' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    await new Promise((res) => setTimeout(res, 50))
    expect(ofType(events, 'accepted')).toEqual([{ type: 'accepted', uuid: 'u-1' }])
    expect(ofType(events, 'turnEnd')).toHaveLength(1)
    expect(ofType(events, 'turnEnd')[0]).toMatchObject({ status: 'completed', result: 'OK', userMessageUuids: ['u-1'] })
    expect(ofType(events, 'turnEnd')[0].usage.context_window).toBe(131072)
    expect(reqs('POST', /prompt_async$/)[0].body).toEqual({ parts: [{ type: 'text', text: 'Reply with exactly: OK' }], agent: 'build', model: { providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free' }, variant: 'low' })
  })

  it('compact: summarize with the session model; the stream says compacted; the window is the model limit', async () => {
    const { chat, events, reqs } = setup({ model: 'opencode/nemotron-3.5-lightning-free' })
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.compact()).toEqual({ ok: true })
    expect(reqs('POST', /summarize$/)[0].body).toEqual({ providerID: 'opencode', modelID: 'nemotron-3.5-lightning-free' })
    await waitFor(() => ofType(events, 'compacted').length, 8000, 'compacted')
    await chat.send({ uuid: 'u-2', text: 'Reply with exactly: OK' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    expect(ofType(events, 'contextUsage').at(-1).windowTokens).toBe(131072)
  })

  it('a permission ask: a card, then allow once / for the session / deny', async () => {
    for (const [decision, reply] of [
      [{ behavior: 'allow' }, { reply: 'once' }],
      [{ behavior: 'allow', session: true }, { reply: 'always' }],
      [{ behavior: 'deny', message: 'The user denied this.' }, { reply: 'reject', message: 'The user denied this.' }]
    ]) {
      const { chat, events, reqs } = setup()
      expect((await chat.start()).ok).toBe(true)
      await chat.send({ uuid: 'u-2', text: 'Run the shell command `echo tessel` with the bash tool' })
      const perm = await waitFor(() => ofType(events, 'permission')[0], 8000, 'permission')
      expect(perm).toMatchObject({ toolName: 'Bash', input: { command: 'echo tessel' }, sessionRules: [{ kind: 'rule', tool: 'bash', content: 'echo *' }], choices: ['accept', 'acceptForSession', 'decline'], toolUseId: 'call-586cd5ed-3dfd-43d4-b45a-ec41f9dce85a' })
      expect(perm.requestId).toMatch(/^oc_perm_/)
      expect(chat.pendingPermissions()).toEqual([perm.requestId])
      expect(await chat.answerPermission(perm.requestId, decision)).toMatchObject({ ok: true, decision: reply.reply })
      expect(await chat.answerPermission(perm.requestId, decision)).toMatchObject({ ok: false })
      await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
      expect(reqs('POST', /^\/permission\/per_0ef9ab1bb001CH7wnLSgA7QuRU\/reply$/).map((r) => r.body)).toEqual([reply])
      await chat.close({ kill: true })
    }
  })

  it('a sub-agent: its session tracked, its ask shown with its provenance', async () => {
    const { chat, events, reqs } = setup()
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'u-3', text: 'Use the task tool CHILDASK' })
    const perm = await waitFor(() => ofType(events, 'permission')[0], 8000, 'child permission')
    expect(perm.toolUseId).toBe('ses_f10653fd7ffeMgYqwu9LT2ywkK:call-child-1')
    expect(perm.description).toBe('Reply with OK')
    await chat.answerPermission(perm.requestId, { behavior: 'allow' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    expect(reqs('POST', /^\/permission\/per_childask/)[0].body).toEqual({ reply: 'once' })
    expect(ofType(events, 'subagent').filter((e) => e.phase === 'end')[0]).toMatchObject({ id: 'ses_f10653fd7ffeMgYqwu9LT2ywkK', status: 'completed' })
    expect(ofType(events, 'assistant').some((e) => e.agentId === 'ses_f10653fd7ffeMgYqwu9LT2ywkK')).toBe(true)
  })

  it('Yolo: a sub-agent ask is answered once without a card', async () => {
    const { chat, events, reqs } = setup({ permissions: 'yolo' })
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'u-4', text: 'Use the task tool CHILDASK' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    expect(ofType(events, 'permission')).toEqual([])
    expect(reqs('POST', /^\/permission\/per_childask/)[0].body).toEqual({ reply: 'once' })
  })

  it('the provider-error turn fails once', async () => {
    const { chat, events } = setup()
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'u-5', text: 'FAIL please' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    await new Promise((res) => setTimeout(res, 100))
    const ends = ofType(events, 'turnEnd')
    expect(ends).toHaveLength(1)
    expect(ends[0]).toMatchObject({ status: 'failed' })
    expect(ends[0].result).toMatch(/Upstream request failed/)
    expect(ofType(events, 'retry').length).toBe(5)
  })

  it('compact -> POST /session/:id/summarize', async () => {
    const { chat, reqs } = setup()
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.compact()).toEqual({ ok: true })
    expect(reqs('POST', /\/summarize$/)).toHaveLength(1)
  })

  it('interrupt aborts the turn: interrupted', async () => {
    const { chat, events, reqs } = setup()
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'u-6', text: 'HANG' })
    await waitFor(() => ofType(events, 'accepted').length, 8000, 'accepted')
    expect(await chat.interrupt()).toMatchObject({ ok: true })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    expect(ofType(events, 'turnEnd')[0].status).toBe('interrupted')
    expect(reqs('POST', /\/abort$/)).toHaveLength(1)
  })

  it('a question: a card, answered with the chosen labels', async () => {
    const { chat, events, reqs } = setup()
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'u-7', text: 'QUESTION' })
    const q = await waitFor(() => ofType(events, 'question')[0], 8000, 'question')
    expect(q.questions[0]).toMatchObject({ id: 'q0', question: 'Which format?', multiSelect: false, freeTextQuestionId: 'q0' })
    expect(await chat.answerQuestion(q.requestId, { answers: [{ questionId: 'q0', optionIds: ['o1'] }] })).toEqual({ ok: true })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    expect(reqs('POST', /^\/question\/que_fake/)[0]).toMatchObject({ path: '/question/que_fake0000000000000000001/reply', body: { answers: [['Full']] } })
  })

  it('a slash command from the catalog runs through /command', async () => {
    const { chat, events, reqs } = setup()
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.send({ uuid: 'u-8', text: '/review HEAD~1' })).toMatchObject({ ok: true, command: 'review' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    expect(reqs('POST', /\/command$/)[0].body).toMatchObject({ command: 'review', arguments: 'HEAD~1', agent: 'build' })
    expect(reqs('POST', /prompt_async$/)).toEqual([])
    expect(ofType(events, 'turnEnd')[0].userMessageUuids).toEqual(['u-8'])
  })

  it('skills come from GET /skill, without their body', async () => {
    const { chat } = setup()
    expect((await chat.start()).ok).toBe(true)
    const r = await chat.skills()
    expect(r.ok).toBe(true)
    expect(r.result.skills[0]).toMatchObject({ name: 'review', providers: ['opencode'], sourceKind: 'repo' })
    expect(JSON.stringify(r)).not.toMatch(/SECRET BODY/)
  })
})

describe('OpenCode chat: posture changes and close', () => {
  it('switches Manual / Plan with PATCH and checks again; Yolo only for a Yolo start', async () => {
    const { chat, reqs } = setup()
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.setPermissionMode('plan')).toMatchObject({ ok: true })
    const patch = reqs('PATCH', /^\/session\//).at(-1)
    expect(patch.body.permission.at(-1)).toEqual({ permission: 'edit', pattern: '*', action: 'deny' })
    expect(await chat.setPermissionMode('bypassPermissions')).toMatchObject({ ok: false })
    await chat.send({ uuid: 'u-9', text: 'Reply with exactly: OK' })
    await new Promise((r) => setTimeout(r, 30))
    expect(reqs('POST', /prompt_async$/)[0].body.agent).toBe('plan')
  })

  it('a Yolo chat switched to Manual gets strict rules', async () => {
    const { chat, reqs } = setup({ permissions: 'yolo' })
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.setPermissionMode('default')).toMatchObject({ ok: true })
    expect(reqs('PATCH', /^\/session\//).at(-1).body.permission[0]).toEqual({ permission: '*', pattern: '*', action: 'ask' })
    expect(await chat.setPermissionMode('bypassPermissions')).toMatchObject({ ok: true })
  })

  it('a session whose rules change under Manual closes the chat', async () => {
    const { chat, events, readLog, killed } = setup()
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'u-11', text: 'LOOSEN' })
    await waitFor(() => ofType(events, 'postureError').length, 8000, 'postureError')
    await waitFor(() => ofType(events, 'exit').length, 8000, 'exit')
    expect(killed.length).toBe(1)
    expect(readLog().some((l) => l.t === 'req' && /\/abort$/.test(l.path))).toBe(true)
  })

  it('close aborts a running turn, then kills the tree by our PID', async () => {
    const { chat, events, reqs, killed } = setup()
    expect((await chat.start()).ok).toBe(true)
    const pid = chat.pid
    await chat.send({ uuid: 'u-10', text: 'HANG' })
    await waitFor(() => ofType(events, 'accepted').length, 8000, 'accepted')
    expect(await chat.close()).toMatchObject({ ok: true, killed: true })
    expect(reqs('POST', /\/abort$/)).toHaveLength(1)
    expect(killed).toEqual([pid])
    expect(ofType(events, 'exit')[0]).toMatchObject({ crashed: false })
    expect(chat.running).toBe(false)
  })

  it('an unexpected exit is a crash', async () => {
    const { chat, events } = setup()
    expect((await chat.start()).ok).toBe(true)
    process.kill(chat.pid)
    await waitFor(() => ofType(events, 'exit').length, 8000, 'exit')
    expect(ofType(events, 'exit')[0].crashed).toBe(true)
  })
})

describe('OpenCode chat: security review', () => {
  const alive = (pid) => {
    try {
      process.kill(pid, 0)
      return true
    } catch {
      return false
    }
  }

  it('refuses a server that answers without its password (code auth)', async () => {
    const { chat, killed } = setup({ env: { FAKE_OC_NO_AUTH: '1' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'auth' })
    expect(killed.length).toBe(1)
  })

  it('refuses an OpenCode older than the tested version (code version)', async () => {
    const { chat } = setup({ env: { FAKE_OC_VERSION: '1.18.32' } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false, code: 'version' })
    expect(r.error).toMatch(/older than 1\.18\.33/)
  })

  it('a hidden agent that allows everything joins the strict config (one restart); task allows only checked sub-agents', async () => {
    const { chat, readLog, reqs } = setup({ env: { FAKE_OC_HIDDEN_LOOSE: '1' } })
    expect((await chat.start()).ok).toBe(true)
    const starts = readLog().filter((l) => l.t === 'start')
    expect(starts).toHaveLength(2)
    expect(Object.keys(JSON.parse(starts[1].config).agent)).toContain('helper')
    const rules = reqs('POST', /^\/session$/).at(-1).body.permission
    expect(rules.filter((x) => x.permission === 'task')).toEqual([
      { permission: 'task', pattern: '*', action: 'ask' },
      { permission: 'task', pattern: 'general', action: 'allow' },
      { permission: 'task', pattern: 'explore', action: 'allow' }
    ])
  })

  it('"allow for this session" then Manual: the server restarts on the same conversation, its grants gone', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessel-oc-grants-'))
    const { chat, events, readLog, reqs, killed } = setup({ cwd: dir, env: { FAKE_OC_STATE: join(dir, 'state.json') } })
    expect((await chat.start()).ok).toBe(true)
    const sid = chat.sessionId
    const firstPid = chat.pid
    // No grant yet: a switch is a PATCH only.
    expect(await chat.setPermissionMode('plan')).toMatchObject({ ok: true })
    expect(readLog().filter((l) => l.t === 'start')).toHaveLength(1)
    expect(await chat.setPermissionMode('default')).toMatchObject({ ok: true })
    await chat.send({ uuid: 'g-1', text: 'Run the shell command `echo tessel` with the bash tool' })
    const perm = await waitFor(() => ofType(events, 'permission')[0], 8000, 'permission')
    expect(await chat.answerPermission(perm.requestId, { behavior: 'allow', session: true })).toMatchObject({ decision: 'always' })
    await waitFor(() => ofType(events, 'turnEnd').length, 8000, 'turnEnd')
    const r = await chat.setPermissionMode('plan')
    expect(r).toMatchObject({ ok: true, restarted: true })
    expect(readLog().filter((l) => l.t === 'start')).toHaveLength(2)
    expect(killed).toContain(firstPid)
    expect(chat.pid).not.toBe(firstPid)
    expect(chat.sessionId).toBe(sid)
    expect(ofType(events, 'exit')).toEqual([]) // the chat goes on
    const patch = reqs('PATCH', /^\/session\//).at(-1)
    expect(patch.body.permission.at(-1)).toEqual({ permission: 'edit', pattern: '*', action: 'deny' })
    // And it still works.
    await chat.send({ uuid: 'g-2', text: 'Reply with exactly: OK' })
    await waitFor(() => ofType(events, 'turnEnd').length >= 2, 8000, 'second turnEnd')
    // A second switch: no grant any more, no restart.
    expect(await chat.setPermissionMode('default')).not.toHaveProperty('restarted')
  })

  it('leaving Yolo: a sub-agent ask is a card again', async () => {
    const { chat, events } = setup({ permissions: 'yolo' })
    expect((await chat.start()).ok).toBe(true)
    expect(await chat.setPermissionMode('default')).toMatchObject({ ok: true })
    await chat.send({ uuid: 'y-1', text: 'Use the task tool CHILDASK' })
    const perm = await waitFor(() => ofType(events, 'permission')[0], 8000, 'permission')
    expect(perm.toolUseId).toMatch(/call-child-1$/)
  })

  it('checks the posture again before each prompt (a config loosened behind the chat)', async () => {
    const { chat, events, reqs } = setup({ env: { FAKE_OC_LOOSE_CONFIG_FROM: '2' } })
    expect((await chat.start()).ok).toBe(true)
    const r = await chat.send({ uuid: 'c-1', text: 'Reply with exactly: OK' })
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/config agent general: webfetch allow/)
    expect(reqs('POST', /prompt_async$/)).toEqual([])
    await waitFor(() => ofType(events, 'postureError').length, 8000, 'postureError')
  })

  it('refuses a GET /config that is loose at the start', async () => {
    const { chat } = setup({ env: { FAKE_OC_LOOSE_CONFIG: '1' } })
    expect(await chat.start()).toMatchObject({ ok: false, code: 'posture' })
  })

  it('refuses to grow a session past its rule cap', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessel-oc-cap-'))
    const id = 'ses_capcap0000000000000000001'
    const permission = Array.from({ length: 1995 }, () => ({ permission: '*', pattern: '*', action: 'ask' }))
    const { chat } = setup({ cwd: dir, sessionId: id, env: { FAKE_OC_SESSIONS: JSON.stringify([{ id, directory: dir, permission }]) } })
    const r = await chat.start()
    expect(r).toMatchObject({ ok: false })
    expect(r.error).toMatch(/too many times/)
  })

  it('drops one event over the size cap and goes on', async () => {
    const { chat, events } = setup()
    expect((await chat.start()).ok).toBe(true)
    await chat.send({ uuid: 'h-1', text: 'HUGE' })
    await waitFor(() => ofType(events, 'turnEnd').length, 15000, 'turnEnd')
    expect(ofType(events, 'turnEnd')[0]).toMatchObject({ status: 'completed', result: 'Small.' })
    expect(ofType(events, 'assistant').every((e) => JSON.stringify(e).length < 100000)).toBe(true)
  })

  it('a close while it starts leaves no server (first boot and the restart)', async () => {
    for (const env of [{}, { FAKE_OC_EXTRA_AGENT: 'reviewer' }]) {
      const { chat, readLog } = setup({ env })
      const started = chat.start()
      await waitFor(() => readLog().filter((l) => l.t === 'listen').length >= (env.FAKE_OC_EXTRA_AGENT ? 2 : 1), 8000, 'listen')
      await chat.close()
      expect((await started).ok).toBe(false)
      const listens = readLog().filter((l) => l.t === 'listen')
      await new Promise((r) => setTimeout(r, 200))
      for (const l of listens) expect(await rawGet(l.port, '/global/health').catch(() => 'gone')).toBe('gone')
    }
  })

  it('records the server PID until it exits', async () => {
    const added = []
    const removed = []
    const pids = { add: (p) => added.push(p), remove: (p) => removed.push(p) }
    const { chat } = setup({ pids })
    expect((await chat.start()).ok).toBe(true)
    const pid = chat.pid
    expect(added).toEqual([pid])
    await chat.close()
    await waitFor(() => removed.includes(pid), 5000, 'removed')
    expect(alive(pid)).toBe(false)
  })

  it('loads the env plugin that empties the password for the shells of the agent', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'tessel-oc-plugin-'))
    const file = join(dir, 'p', 'tessel-chat-env.mjs')
    const { chat, readLog } = setup({ envPluginFile: file })
    expect((await chat.start()).ok).toBe(true)
    const config = JSON.parse(readLog().find((l) => l.t === 'start').config)
    expect(config.plugin).toEqual([pathToFileURL(file).href])
    const text = readFileSync(file, 'utf8')
    expect(text).toContain("'shell.env'")
    expect(text).toContain("OPENCODE_SERVER_PASSWORD: ''")
    const mod = await import(/* @vite-ignore */ pathToFileURL(file).href)
    const hooks = await mod.TesselChatEnv()
    const output = { env: { KEEP: '1' } }
    await hooks['shell.env']({}, output)
    expect(output.env).toEqual({ KEEP: '1', OPENCODE_SERVER_PASSWORD: '', OPENCODE_SERVER_USERNAME: '' })
  })
})

describe('OpenCode chat: earlier history', () => {
  it('reads the conversation from the server with the password', async () => {
    const { chat, reqs } = setup({ env: { FAKE_OC_HISTORY: '1' } })
    expect((await chat.start()).ok).toBe(true)
    const r = await chat.history()
    expect(r).toMatchObject({ ok: true, truncated: false })
    expect(r.messages).toHaveLength(8)
    expect(r.messages[0].info.sessionID).toBe(chat.sessionId)
    expect(reqs('GET', /\/message$/)[0]).toMatchObject({ authed: true })
  })

  it('asks for fewer messages when they are over the byte cap', async () => {
    const { chat, reqs } = setup({ env: { FAKE_OC_HISTORY: 'big' } })
    expect((await chat.start()).ok).toBe(true)
    const r = await chat.history({ limit: 16, maxBytes: 4 * 1024 * 1024 })
    expect(r.ok).toBe(true)
    expect(r.truncated).toBe(true)
    expect(r.messages.length).toBeLessThanOrEqual(4)
    expect(reqs('GET', /\/message$/).length).toBeGreaterThan(1)
  })
})
