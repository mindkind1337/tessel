import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { executeCommand, watchForInput, waitForIdle } from '../agentTerminal/executeStrategy'
import { fakeTerminal } from './fakeTerminal'
import { parseShellSequence, deserializeValue, getRawOutput, readText } from '../agentTerminal/screenRead'
import { pwshInit, posixInit, initLineFor } from '../agentTerminal/shellInit'

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())

describe('the shell\'s reports (OSC 633 / 133)', () => {
  it('parses the sequences and their values', () => {
    expect(parseShellSequence('D;130')).toEqual({ type: 'D', exitCode: 130 })
    expect(parseShellSequence('D')).toEqual({ type: 'D' })
    expect(parseShellSequence('E;ls\\x3b pwd;nonce')).toEqual({ type: 'E', commandLine: 'ls; pwd' })
    expect(parseShellSequence('P;Cwd=C:\\x5cUsers')).toEqual({ type: 'P', key: 'Cwd', value: 'C:\\Users' })
    expect(parseShellSequence('Z')).toBe(null)
    expect(deserializeValue('a\\\\b')).toBe('a\\b')
  })
  it('tracks commands: executing, finished with its exit code, the last one', () => {
    const t = fakeTerminal({ quality: 'basic' })
    const ends = []
    t.shell.onCommandFinished((c) => ends.push(c))
    t.osc('B')
    t.osc('E;make')
    t.osc('C')
    expect(t.shell.executing()).toBe(true)
    t.osc('D;2')
    expect(t.shell.executing()).toBe(false)
    expect(ends[0]).toMatchObject({ exitCode: 2, commandLine: 'make' })
    expect(t.shell.lastCommand().commandLine).toBe('make')
    expect(t.shell.quality()).toBe('basic')
  })
})

describe('running a command', () => {
  it('no shell integration: done when the output idles on a prompt', async () => {
    const t = fakeTerminal()
    t.onSend = (text) => setTimeout(() => t.print(`${text}\nhello\nPS C:\\p> `), 50)
    const p = executeCommand(t, 'echo hello', {})
    await vi.advanceTimersByTimeAsync(10000)
    const r = await p
    expect(r).toMatchObject({ output: 'hello', strategy: 'none' })
    expect(t.sent).toEqual(['echo hello'])
  })

  it('no prompt in sight: waits longer, then gives what it has', async () => {
    const t = fakeTerminal()
    t.onSend = (text) => setTimeout(() => t.print(`${text}\nstill working`), 50)
    let done = false
    const p = executeCommand(t, 'build', {}).then((r) => ((done = true), r))
    await vi.advanceTimersByTimeAsync(5000)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(20000)
    expect((await p).output).toContain('still working')
  })

  it('rich: done when the shell says the command ended, with its exit code', async () => {
    const t = fakeTerminal({ quality: 'rich' })
    t.onSend = (text) =>
      setTimeout(() => {
        t.print(`${text}\n`)
        t.osc('C')
        t.print('compiled\n')
        t.osc('D;3')
        t.osc('A')
        t.print('PS C:\\p> ')
        t.osc('B')
      }, 50)
    const p = executeCommand(t, 'make', {})
    await vi.advanceTimersByTimeAsync(3000)
    const r = await p
    expect(r).toMatchObject({ exitCode: 3, strategy: 'rich' })
    expect(r.output).toContain('compiled')
    expect(r.additionalInformation).toContain('Command exited with code 3')
  })

  it('basic: the end event, then a short idle on the prompt', async () => {
    const t = fakeTerminal({ quality: 'basic' })
    t.onSend = (text) =>
      setTimeout(() => {
        t.print(`${text}\nok\n`)
        t.osc('D;0')
        t.osc('A')
        t.print('PS C:\\p> ')
      }, 50)
    const p = executeCommand(t, 'npm test', {})
    await vi.advanceTimersByTimeAsync(6000)
    const r = await p
    expect(r).toMatchObject({ exitCode: 0, output: 'ok', strategy: 'basic' })
  })

  it('a full-screen program: no output, said so', async () => {
    const t = fakeTerminal()
    t.onSend = () => setTimeout(() => t.enterAlt(), 50)
    const p = executeCommand(t, 'vim', {})
    await vi.advanceTimersByTimeAsync(3000)
    expect(await p).toMatchObject({ didEnterAltBuffer: true })
  })

  it('stopped: ends at once with what was printed', async () => {
    const t = fakeTerminal()
    let stop
    const cancelled = new Promise((r) => (stop = r))
    t.onSend = (text) => setTimeout(() => t.print(`${text}\npartial`), 50)
    const p = executeCommand(t, 'sleep 100', { cancelled })
    await vi.advanceTimersByTimeAsync(1500)
    stop()
    await vi.advanceTimersByTimeAsync(10)
    expect(await p).toMatchObject({ cancelled: true })
  })

  it('clears the user\'s line first in the agent\'s own terminal (Ctrl+U)', async () => {
    const t = fakeTerminal()
    t.onSend = (text) => setTimeout(() => t.print(`${text}\nPS C:\\p> `), 50)
    const p = executeCommand(t, 'ls', { hasUserInput: () => true })
    await vi.advanceTimersByTimeAsync(10000)
    await p
    expect(t.written).toEqual(['\x15'])
  })

  it('waits for the terminal to be quiet before typing', async () => {
    const t = fakeTerminal()
    const idle = waitForIdle(t, 1000)
    let done = false
    idle.then(() => (done = true))
    await vi.advanceTimersByTimeAsync(800)
    t.print('x')
    await vi.advanceTimersByTimeAsync(800)
    expect(done).toBe(false)
    await vi.advanceTimersByTimeAsync(300)
    expect(done).toBe(true)
  })
})

describe('a command asking something', () => {
  it('a question, then a secret', async () => {
    const t = fakeTerminal()
    const w = watchForInput(t, { command: 'npm init' })
    t.print('\npackage name: (demo) ')
    await vi.advanceTimersByTimeAsync(1100)
    expect(await w.promise).toBe('input')
    w.stop()
    const t2 = fakeTerminal()
    const w2 = watchForInput(t2, { command: 'ssh host' })
    t2.print('\nme@host password: ')
    await vi.advanceTimersByTimeAsync(1100)
    expect(await w2.promise).toBe('sensitive')
    w2.stop()
  })
  it('the user typing meanwhile: they answer, nothing is reported', async () => {
    const t = fakeTerminal()
    const w = watchForInput(t, {})
    let got = null
    w.promise.then((k) => (got = k))
    t.print('\nContinue? (y/n) ')
    t.type()
    await vi.advanceTimersByTimeAsync(1100)
    expect(got).toBe(null)
    w.stop()
  })
})

describe('reading the screen', () => {
  // A minimal xterm buffer.
  function term(lines, wrapped = []) {
    const rows = lines.map((text, i) => ({ translateToString: (trim) => (trim ? text.replace(/\s+$/, '') : text), isWrapped: wrapped.includes(i) }))
    return { buffer: { active: { length: rows.length, getLine: (y) => rows[y] } } }
  }
  it('joins wrapped rows, keeps the last N lines', () => {
    const t = term(['one', 'two-a', 'two-b', 'three', '', ''], [2])
    expect(readText(t, 2)).toBe('two-atwo-b\nthree')
    expect(getRawOutput(t, { line: 2 }, null)).toBe('two-atwo-b\nthree')
  })
})

describe('the first line in an agent\'s own terminal', () => {
  it('sets VS Code\'s agent variables and the shell integration, starts with a space', () => {
    const p = pwshInit()
    expect(p.startsWith(' ')).toBe(true)
    expect(p).toContain("$env:GIT_PAGER='cat'")
    expect(p).toContain("$env:AI_AGENT='tessel'")
    expect(p).toContain('633;D;$c')
    const b = posixInit()
    expect(b).toContain("DEBIAN_FRONTEND='noninteractive'")
    expect(b).toContain('HISTCONTROL=ignorespace')
    expect(initLineFor('cmd')).toBe(null)
    expect(initLineFor('ssh')).toBe(b)
  })
})

describe('security review: the badge\'s log', () => {
  it('keeps reads apart from commands', async () => {
    const { onTerminalLog, terminalLog } = await import('../agentTerminal/agentTerminalState')
    onTerminalLog({ paneId: 'p-read', at: 1, agent: 'Ada', kind: 'read', text: '' })
    expect(terminalLog['p-read'][0].kind).toBe('read')
  })
})
