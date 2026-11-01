// @vitest-environment node
// A command the host's agent asks to run on a guest's computer: what the guest's
// side accepts to show, and how it runs.
import { describe, it, expect, vi } from 'vitest'
import { EventEmitter } from 'node:events'
import { GUEST_COMMAND_LIMITS, cleanCommandAsk, cleanCommandResult, commandsPossible, isCommandId, runGuestCommand } from '../liveShare/guestCommand.js'

const ask = (extra = {}) => ({ id: 'a-1', command: 'Get-ChildItem', agent: 'Ada', project: 'Site', why: 'To read the log', goal: 'Find the crash', ...extra })

describe('what a host may ask', () => {
  it('a plain command comes through as it is', () => {
    expect(cleanCommandAsk(ask())).toEqual({ id: 'a-1', command: 'Get-ChildItem', agent: 'Ada', project: 'Site', why: 'To read the log', goal: 'Find the crash', timeoutMs: GUEST_COMMAND_LIMITS.defaultMs })
  })

  it.each([
    ['nothing', null],
    ['no command', { id: 'a-1' }],
    ['a command that is not text', ask({ command: ['calc.exe'] })],
    ['an empty command', ask({ command: '   ' })],
    ['a bad id', ask({ id: 'a b/../c' })],
    ['an escape sequence that repaints the line', ask({ command: 'Get-Date\x1b[2K\rcalc.exe' })],
    ['a null character', ask({ command: 'Get-Date\x00calc.exe' })],
    ['a bidi override: the line reads differently from what runs', ask({ command: 'echo safe\u202Eexe.clac' })],
    ['a zero-width mark', ask({ command: 'cal\u200Bc.exe' })],
    ['curly quotes, which PowerShell takes for real ones', ask({ command: "echo 'Don\u2019t; calc; echo \u2019ok'" })],
    ['curly double quotes', ask({ command: 'echo "a\u201D; calc; echo \u201Cb"' })],
    ['a long dash, which PowerShell takes for a hyphen', ask({ command: 'Get-Date \u2013Format x' })],
    ['a no-break space, which pushes a quote out of sight', ask({ command: `$a = 'x${'\u00A0'.repeat(62)}'` })],
    ['a figure space', ask({ command: 'echo\u2007calc' })],
    ['a run of plain blanks to the same end', ask({ command: `echo 'x${' '.repeat(40)}'` })],
    ['variation selectors, which can hide a payload', ask({ command: "$s='.\uFE00\uFE01'" })],
    ['a tag character', ask({ command: 'echo \u{E0041}' })],
    ['a Hangul filler', ask({ command: 'echo \u3164' })],
    ['a braille blank', ask({ command: 'echo \u2800' })],
    ['a combining mark, which smears over its neighbours', ask({ command: 'echo e\u0301' })],
    ['letters written right to left, which reorder what is around them', ask({ command: 'echo 1 ; \u05D0 ; 2 ; 3' })],
    ['a look-alike letter from another alphabet', ask({ command: 'curl https://p\u0430ypal.example' })],
    ['a lone surrogate', ask({ command: 'echo \uD800' })],
    ['a Latin letter that is a quote to the eye', ask({ command: "echo 'all fine\uA78C; calc; echo done'" })],
    ['the capital of it', ask({ command: "echo \uA78B; calc" })],
    ['a Latin letter that is an l to the eye', ask({ command: "$\u0196='calc'; $l='x'; iex $\u0196" })],
    ['the Kelvin sign, which is a K to the eye', ask({ command: 'echo \u212A' })],
    ['a Latin letter that is a pipe to the eye', ask({ command: 'echo a \u01C0 calc' })],
    ['a dotless i', ask({ command: 'echo \u0131' })],
    ['a line separator', ask({ command: 'Get-Date\u2028calc.exe' })],
    ['blank lines pushing a part out of sight', ask({ command: 'Get-Date\n\n\n\ncalc.exe' })],
    ['too long', ask({ command: 'x'.repeat(GUEST_COMMAND_LIMITS.commandBytes + 1) })],
    ['too many lines', ask({ command: Array(GUEST_COMMAND_LIMITS.commandLines + 1).fill('x').join('\n') })]
  ])('refuses %s', (_name, msg) => {
    expect(cleanCommandAsk(msg)).toBeNull()
  })

  it('accents stay: what French paths and words need', () => {
    expect(cleanCommandAsk(ask({ command: 'Get-Content "C:\\Users\\Andr\u00E9\\\u00E9t\u00E9.log"' })).command).toContain('\u00E9t\u00E9')
    expect(cleanCommandAsk(ask({ command: 'a\tb\nc' })).command).toBe('a\tb\nc')
    for (const word of ['\u0141ukasz', '\u017Di\u017Eek', 'M\u00FCller', 'c\u0153ur', 'Fran\u00E7ois']) expect(cleanCommandAsk(ask({ command: `echo ${word}` }))).not.toBeNull()
  })

  it('the host\'s other words come in as short plain text', () => {
    const c = cleanCommandAsk(ask({ agent: 'Ada\n\x1b[31mAllow!', why: `a\u202Eb\uFE00e\u0301 ${'x'.repeat(2000)}`, project: 12 }))
    expect(c.why.startsWith('a b é')).toBe(true)
    expect(c.agent).toBe('Ada [31mAllow!')
    expect(c.why).not.toMatch(/\u202E/)
    expect(c.why.length).toBe(GUEST_COMMAND_LIMITS.text)
    expect(c.project).toBe('')
  })

  it('its time is bounded', () => {
    expect(cleanCommandAsk(ask({ timeoutMs: 999999999 })).timeoutMs).toBe(GUEST_COMMAND_LIMITS.maxMs)
    expect(cleanCommandAsk(ask({ timeoutMs: 1 })).timeoutMs).toBe(1000)
    expect(cleanCommandAsk(ask({ timeoutMs: 'x' })).timeoutMs).toBe(GUEST_COMMAND_LIMITS.defaultMs)
  })

  it('an id is a short plain word', () => {
    expect(isCommandId('6f1c-aa_2')).toBe(true)
    expect(isCommandId('x'.repeat(65))).toBe(false)
    expect(isCommandId(7)).toBe(false)
  })
})

describe('where it can run', () => {
  it('on Windows only: what the card and the agent say', () => {
    expect(commandsPossible('win32')).toBe(true)
    expect(commandsPossible('linux')).toBe(false)
    expect(commandsPossible('darwin')).toBe(false)
  })
})

describe('what a guest may answer', () => {
  it('keeps the known shapes, bounded', () => {
    expect(cleanCommandResult({ ok: true, state: 'completed', exitCode: 3, output: 'hi', extra: 1 })).toEqual({ ok: true, state: 'completed', exitCode: 3, output: 'hi' })
    expect(cleanCommandResult({ ok: true, state: 'weird', exitCode: 'x', output: 5 })).toEqual({ ok: true, state: 'failed', exitCode: null, output: '' })
    expect(cleanCommandResult({ ok: true, state: 'completed', output: 'x'.repeat(GUEST_COMMAND_LIMITS.output + 5) }).output.length).toBe(GUEST_COMMAND_LIMITS.output)
    expect(cleanCommandResult({ ok: false, code: 'denied' })).toEqual({ ok: false, code: 'denied' })
    expect(cleanCommandResult({ ok: false, code: 'whatever' })).toEqual({ ok: false, code: 'failed' })
    expect(cleanCommandResult(null)).toEqual({ ok: false, code: 'failed' })
  })
})

describe('running it', () => {
  function fakeSpawn() {
    const started = []
    const spawnFn = vi.fn((file, args, opts) => {
      const child = new EventEmitter()
      child.pid = 4242
      child.stdout = new EventEmitter()
      child.stderr = new EventEmitter()
      child.kill = vi.fn()
      started.push({ file, args, opts, child })
      return child
    })
    return { spawnFn, started }
  }
  const options = (spawnFn, extra = {}) => ({ command: 'Get-Date', spawnFn, env: { SystemRoot: 'C:\\Windows', PATH: 'x', TESSEL_TEAM_SECRET: 'secret', ELECTRON_RUN_AS_NODE: '1' }, cwd: 'C:\\Users\\me', ...extra })

  it('in a fresh PowerShell by its full path, no profile, no input, without Tessel\'s secrets', () => {
    const { spawnFn, started } = fakeSpawn()
    runGuestCommand(options(spawnFn))
    const { file, args, opts } = started[0]
    expect(file).toBe('C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe')
    expect(args).toEqual(expect.arrayContaining(['-NoProfile', '-NonInteractive']))
    const encoded = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(args.at(-1))[1]
    expect(Buffer.from(encoded, 'base64').toString('utf16le')).toBe('Get-Date')
    expect(opts.stdio[0]).toBe('ignore')
    expect(opts.windowsHide).toBe(true)
    expect(opts.env).toEqual({ SystemRoot: 'C:\\Windows', PATH: 'x' })
  })

  it('gives its output and exit code, a character split across chunks intact', async () => {
    const { spawnFn, started } = fakeSpawn()
    const run = runGuestCommand(options(spawnFn))
    const { child } = started[0]
    const e = Buffer.from('é', 'utf8')
    child.stdout.emit('data', e.subarray(0, 1))
    child.stdout.emit('data', e.subarray(1))
    child.stderr.emit('data', Buffer.from(' err'))
    child.emit('close', 3)
    expect(await run.promise).toEqual({ state: 'completed', exitCode: 3, output: 'é err' })
  })

  it('keeps the end of a long output', async () => {
    const { spawnFn, started } = fakeSpawn()
    const run = runGuestCommand(options(spawnFn))
    const { child } = started[0]
    for (let i = 0; i < 4; i++) child.stdout.emit('data', Buffer.from('x'.repeat(GUEST_COMMAND_LIMITS.output)))
    child.stdout.emit('data', Buffer.from('END'))
    child.emit('close', 0)
    const { output } = await run.promise
    expect(output.endsWith('END')).toBe(true)
    expect(output.startsWith('[older output dropped]')).toBe(true)
    expect(output.length).toBeLessThan(GUEST_COMMAND_LIMITS.output + 40)
  })

  it('Stop ends the whole tree, by the full path of taskkill', async () => {
    const { spawnFn, started } = fakeSpawn()
    const run = runGuestCommand(options(spawnFn))
    run.stop()
    expect(started[1].file).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(started[1].args).toEqual(['/PID', '4242', '/T', '/F'])
    started[0].child.emit('close', 1)
    expect((await run.promise).state).toBe('stopped')
  })

  it('stops by itself when its time is up, even if something holds its output open', async () => {
    const { spawnFn } = fakeSpawn()
    const run = runGuestCommand(options(spawnFn, { timeoutMs: 5, killWaitMs: 5 }))
    expect((await run.promise).state).toBe('timeout')
  })

  it('a program that cannot start says so', async () => {
    const { spawnFn, started } = fakeSpawn()
    const run = runGuestCommand(options(spawnFn))
    started[0].child.emit('error', new Error('ENOENT'))
    expect(await run.promise).toEqual({ state: 'failed', exitCode: null, output: 'ENOENT' })
    const thrown = runGuestCommand(options(() => { throw new Error('no') }))
    expect((await thrown.promise).state).toBe('failed')
  })

  it('when Tessel quits: the whole tree is ended before it goes on', async () => {
    const { spawnFn, started } = fakeSpawn()
    const spawnSyncFn = vi.fn()
    const run = runGuestCommand(options(spawnFn, { spawnSyncFn, killWaitMs: 5 }))
    run.stop({ now: true })
    expect(spawnSyncFn.mock.calls[0][0]).toBe('C:\\Windows\\System32\\taskkill.exe')
    expect(spawnSyncFn.mock.calls[0][1]).toEqual(['/PID', '4242', '/T', '/F'])
    expect(started).toHaveLength(1)
    expect((await run.promise).state).toBe('stopped')
  })

  it.runIf(process.platform === 'win32')('for real: accents, the exit code, and errors as plain text', async () => {
    const run = runGuestCommand({ command: "Write-Output 'été ok'; Write-Error 'oups'; exit 3", timeoutMs: 30000 })
    const r = await run.promise
    expect(r.state).toBe('completed')
    expect(r.exitCode).toBe(3)
    expect(r.output).toContain('été ok')
    expect(r.output).toContain('oups')
    expect(r.output).not.toContain('CLIXML')
  }, 40000)

  it.runIf(process.platform === 'win32')('for real: quotes and several lines run as they are', async () => {
    const run = runGuestCommand({ command: `$a = "l'été"\nWrite-Output "$a 'x' \`"y\`""`, timeoutMs: 30000 })
    const r = await run.promise
    expect(r.exitCode).toBe(0)
    expect(r.output).toContain(`l'été 'x' "y"`)
  }, 40000)

  it.runIf(process.platform === 'win32')('for real: Stop ends a command that would go on', async () => {
    const run = runGuestCommand({ command: 'Start-Sleep -Seconds 60', timeoutMs: 30000 })
    await new Promise((r) => setTimeout(r, 1500))
    run.stop()
    expect((await run.promise).state).toBe('stopped')
  }, 40000)
})
