// @vitest-environment node
// Programs started from a worker thread (spawnOffThread.js): starting one
// blocks the thread that starts it (seconds on a busy PC), so the main
// process never does it itself while the worker runs.
import { describe, it, expect, vi, afterEach } from 'vitest'
import { createSpawner } from '../spawnOffThread'

const NODE = process.execPath
let spawner = null
afterEach(() => {
  if (spawner) spawner.close()
  spawner = null
})

// The fallbacks fail the test when used: the worker must do the work.
function offThread() {
  const execFile = vi.fn(() => {
    throw new Error('started on this thread')
  })
  const spawn = vi.fn(() => {
    throw new Error('started on this thread')
  })
  spawner = createSpawner({ execFile, spawn })
  return { ...spawner, execFile, spawn }
}
const exec = (s, file, args, opts) => new Promise((resolve) => s.execFileOff(file, args, opts, (err, stdout, stderr) => resolve({ err, stdout, stderr })))

describe('execFileOff', () => {
  it("runs the program in the worker: execFile's callback with its output as text, never a start on this thread", async () => {
    const s = offThread()
    const res = await exec(s, NODE, ['-e', "process.stdout.write('héllo'); process.stderr.write('warn')"], { windowsHide: true, timeout: 20000 })
    expect(res.err).toBeNull()
    expect(res.stdout).toBe('héllo')
    expect(res.stderr).toBe('warn')
    expect(s.execFile).not.toHaveBeenCalled()
  })

  it('gives the exit code and the environment it was given', async () => {
    const s = offThread()
    const res = await exec(s, NODE, ['-e', 'process.stdout.write(process.env.TESSEL_SPAWN_TEST || ""); process.exit(3)'], { env: { ...process.env, TESSEL_SPAWN_TEST: 'yes' } })
    expect(res.err).toBeInstanceOf(Error)
    expect(res.err.code).toBe(3)
    expect(res.stdout).toBe('yes')
  })

  it('a missing program: an error with ENOENT, as execFile gives', async () => {
    const s = offThread()
    const res = await exec(s, 'tessel-no-such-program-xyz', [], {})
    expect(res.err.code).toBe('ENOENT')
  })

  it('stops a program past its timeout (killed)', async () => {
    const s = offThread()
    const res = await exec(s, NODE, ['-e', 'setTimeout(() => {}, 20000)'], { timeout: 300 })
    expect(res.err).toBeInstanceOf(Error)
    expect(res.err.killed).toBe(true)
  })

  it('starts the program here, as before, when the worker cannot start or the options cannot cross', async () => {
    const execFile = vi.fn((file, args, opts, cb) => cb(null, 'here', ''))
    spawner = createSpawner({
      createWorker: () => {
        throw new Error('no workers')
      },
      execFile
    })
    expect((await exec(spawner, 'x', [], {})).stdout).toBe('here')
    const s2 = createSpawner({ execFile })
    try {
      // A signal cannot be sent to a worker: started here.
      expect((await exec(s2, 'x', [], { signal: new AbortController().signal })).stdout).toBe('here')
    } finally {
      s2.close()
    }
    expect(execFile).toHaveBeenCalledTimes(2)
  })
})

describe('spawnOff', () => {
  const run = (child) =>
    new Promise((resolve) => {
      let out = ''
      let err = ''
      child.stdout.on('data', (d) => (out += String(d)))
      child.stderr.on('data', (d) => (err += String(d)))
      child.on('close', (code) => resolve({ code, out, err }))
    })

  it('streams stdin in and stdout out, then exit and close with the code', async () => {
    const s = offThread()
    const child = s.spawnOff(NODE, ['-e', "process.stdin.on('data', (d) => process.stdout.write(String(d).toUpperCase())); process.stdin.on('end', () => process.exit(4))"], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
    const exited = new Promise((resolve) => child.on('exit', (code) => resolve(code)))
    const done = run(child)
    child.stdin.write('abc')
    child.stdin.end('def')
    expect(await done).toMatchObject({ code: 4, out: 'ABCDEF' })
    expect(await exited).toBe(4)
    expect(child.pid).toBeGreaterThan(0)
    expect(s.spawn).not.toHaveBeenCalled()
  })

  it('setEncoding decodes the output (a character split between two chunks included)', async () => {
    const s = offThread()
    const child = s.spawnOff(NODE, ['-e', "const b = Buffer.from('é'); process.stdout.write(b.subarray(0, 1)); setTimeout(() => process.stdout.write(b.subarray(1)), 50)"], {})
    child.stdout.setEncoding('utf8')
    const chunks = []
    child.stdout.on('data', (d) => chunks.push(d))
    await new Promise((resolve) => child.on('close', resolve))
    expect(chunks.join('')).toBe('é')
    expect(chunks.every((c) => typeof c === 'string')).toBe(true)
  })

  it('kill() stops it; a missing program emits error', async () => {
    const s = offThread()
    const child = s.spawnOff(NODE, ['-e', 'setInterval(() => {}, 1000)'], { stdio: ['ignore', 'pipe', 'pipe'] })
    expect(child.stdin).toBeNull()
    await new Promise((resolve) => child.on('spawn', resolve))
    const closed = new Promise((resolve) => child.on('close', resolve))
    expect(child.kill()).toBe(true)
    await closed
    const missing = s.spawnOff('tessel-no-such-program-xyz', [], {})
    const err = await new Promise((resolve) => missing.on('error', resolve))
    expect(err.code).toBe('ENOENT')
  })

  it('the worker ended: the child in flight errors and closes, never left waiting', async () => {
    const s = offThread()
    const child = s.spawnOff(NODE, ['-e', 'setInterval(() => {}, 1000)'], {})
    await new Promise((resolve) => child.on('spawn', resolve))
    const errored = new Promise((resolve) => child.on('error', resolve))
    const closed = new Promise((resolve) => child.on('close', resolve))
    s.close()
    expect((await errored).code).toBe('ESPAWNWORKER')
    await closed
    try {
      process.kill(child.pid)
    } catch {
      /* already gone */
    }
  })
})
