// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  parseNetstatListening,
  parseLsofListening,
  parseAddressWithPort,
  attributePorts,
  createPortScanner,
  sanitizeProbes,
  parseWindowsProcesses,
  parsePsProcesses,
  isTesselProcess
} from '../workspacePorts'
import path from 'path'

const NETSTAT = `
Active Connections

  Proto  Local Address          Foreign Address        State           PID
  TCP    0.0.0.0:135            0.0.0.0:0              LISTENING       1188
  TCP    0.0.0.0:5173           0.0.0.0:0              LISTENING       4242
  TCP    127.0.0.1:9229         0.0.0.0:0              LISTENING       5151
  TCP    127.0.0.1:52000        127.0.0.1:52001        ESTABLISHED     4242
  TCP    [::]:5173              [::]:0                 LISTENING       4242
  TCP    [::1]:3000             [::]:0                 LISTENING       6000
  TCP    [::]:445               [::]:0                 LISTENING       4
`

// Win32_Process rows as agentDetect lists them.
const PROCS = [
  { pid: 4, ppid: 0, name: 'System', cmd: '' },
  { pid: 1188, ppid: 800, name: 'svchost.exe', cmd: 'C:\\Windows\\system32\\svchost.exe -k RPCSS' },
  { pid: 900, ppid: 1, name: 'electron.exe', cmd: 'electron.exe ptyHost.js' },
  { pid: 1000, ppid: 900, name: 'pwsh.exe', cmd: 'pwsh.exe' }, // pane shell, main copy
  { pid: 2000, ppid: 900, name: 'pwsh.exe', cmd: 'pwsh.exe' }, // pane shell, task copy
  { pid: 3000, ppid: 1000, name: 'cmd.exe', cmd: 'cmd /c npm run dev' },
  { pid: 4242, ppid: 3000, name: 'node.exe', cmd: 'node vite' },
  { pid: 5151, ppid: 2000, name: 'node.exe', cmd: 'node --inspect server.js' },
  // Started elsewhere, but its command line names the task copy's folder.
  { pid: 6000, ppid: 1, name: 'python.exe', cmd: 'python -m http.server --directory "C:\\repo.worktrees\\fix-login"' }
]

const PROBES = [
  { id: 'ws1::main', pids: [1000], path: 'C:\\repo' },
  { id: 'ws1::copy', pids: [2000], path: 'C:\\repo.worktrees\\fix-login' }
]

describe('port listing parsers (from Orca)', () => {
  it('reads LISTENING rows of netstat -ano -p tcp, one row per process and address', () => {
    const rows = parseNetstatListening(NETSTAT)
    expect(rows).toEqual([
      { host: '0.0.0.0', port: 135, pid: 1188 },
      { host: '0.0.0.0', port: 5173, pid: 4242 },
      { host: '127.0.0.1', port: 9229, pid: 5151 },
      { host: '::1', port: 3000, pid: 6000 },
      { host: '::', port: 445, pid: 4 }
    ])
  })

  it('reads lsof -F pcn output', () => {
    const out = 'p77\ncnode\nf12\nn*:5173\nn127.0.0.1:5173\np88\ncpython3\nn[::1]:8000\n'
    expect(parseLsofListening(out)).toEqual([
      { pid: 77, processName: 'node', host: '*', port: 5173 },
      { pid: 77, processName: 'node', host: '127.0.0.1', port: 5173 },
      { pid: 88, processName: 'python3', host: '::1', port: 8000 }
    ])
  })

  it('parses addresses, bracketed IPv6 and rejects bad ports', () => {
    expect(parseAddressWithPort('[::1]:3000')).toEqual({ host: '::1', port: 3000 })
    expect(parseAddressWithPort('*:80 (LISTEN)')).toEqual({ host: '*', port: 80 })
    expect(parseAddressWithPort('0.0.0.0:0')).toBeNull()
    expect(parseAddressWithPort('[::1]:999999')).toBeNull()
    expect(parseAddressWithPort('[::1]:65536')).toBeNull()
    expect(parseAddressWithPort('[::1]:0')).toBeNull()
    expect(parseAddressWithPort('[::1]:65535')).toEqual({ host: '::1', port: 65535 })
    expect(parseAddressWithPort('127.0.0.1:65536')).toBeNull()
    expect(parseAddressWithPort('nonsense')).toBeNull()
  })
})

describe('which copy a listener belongs to', () => {
  it('walks the process tree up to a pane shell, then falls back to the folder in its command line', () => {
    const { byProbe: ports, external } = attributePorts(parseNetstatListening(NETSTAT), PROCS, PROBES)
    expect(external.map((p) => [p.port, p.processName, p.kind])).toEqual([
      [135, 'svchost.exe', 'external'],
      [445, 'System', 'external']
    ])
    expect(ports['ws1::main'].map((p) => [p.port, p.processName, p.connectHost, p.confidence])).toEqual([
      [5173, 'node.exe', 'localhost', 'tree']
    ])
    expect(ports['ws1::copy'].map((p) => [p.port, p.processName, p.connectHost, p.confidence])).toEqual([
      [3000, 'python.exe', '::1', 'command'],
      [9229, 'node.exe', '127.0.0.1', 'tree']
    ])
    expect(ports['ws1::main'][0]).toMatchObject({ protocol: 'http', pid: 4242, bindHost: '0.0.0.0', kind: 'workspace' })
  })

  it('ignores system listeners and survives ppid cycles', () => {
    const procs = [
      { pid: 10, ppid: 11, name: 'a', cmd: '' },
      { pid: 11, ppid: 10, name: 'b', cmd: '' }
    ]
    const ports = attributePorts([{ host: '0.0.0.0', port: 80, pid: 10 }], procs, PROBES).byProbe
    expect(ports['ws1::main']).toEqual([])
    expect(ports['ws1::copy']).toEqual([])
  })

  it('keeps only well-formed probes', () => {
    expect(sanitizeProbes([{ id: 'a', pids: [1, -2, 'x'], path: 'C:\\a' }, { nope: 1 }, null])).toEqual([
      { id: 'a', pids: [1], path: 'C:\\a' }
    ])
  })
})

describe('scanner', () => {
  it('shares one listing between scans a few seconds apart', async () => {
    const listeners = vi.fn(async () => parseNetstatListening(NETSTAT))
    const processes = vi.fn(async () => PROCS)
    let t = 1000
    const scanner = createPortScanner({ listeners, processes, now: () => t })
    const a = await scanner.scan({ probes: PROBES })
    t += 1000
    const b = await scanner.scan({ probes: PROBES })
    expect(a.ok && b.ok).toBe(true)
    expect(listeners).toHaveBeenCalledTimes(1)
    expect(processes).toHaveBeenCalledTimes(1)
    t += 10000
    await scanner.scan({ probes: PROBES })
    expect(listeners).toHaveBeenCalledTimes(2)
  })

  it('says why when the ports cannot be listed', async () => {
    const scanner = createPortScanner({ listeners: async () => null, processes: async () => PROCS })
    const res = await scanner.scan({ probes: PROBES })
    expect(res.ok).toBe(false)
    expect(res.unavailableReason).toMatch(/listening ports/)
  })


  it('a fresh scan waits for a scan already running, then lists again itself', async () => {
    let release
    const gate = new Promise((r) => (release = r))
    const listeners = vi.fn(async () => parseNetstatListening(NETSTAT))
    const processes = vi.fn().mockImplementationOnce(() => gate.then(() => PROCS)).mockImplementation(async () => PROCS)
    const scanner = createPortScanner({ listeners, processes })
    const old = scanner.scan({ probes: PROBES })
    const fresh = scanner.scan({ probes: PROBES }, { fresh: true })
    await Promise.resolve()
    expect(listeners).toHaveBeenCalledTimes(1) // the fresh one has not joined nor started yet
    release()
    await old
    expect((await fresh).ok).toBe(true)
    expect(listeners).toHaveBeenCalledTimes(2)
    expect(processes).toHaveBeenCalledTimes(2)
  })
})

// Listing with creation times and executables, as the port scanner lists them.
// 7000 Tessel's main process, 7100 a renderer, 900 the terminal host, 1000 and
// 2000 pane shells (under the host).
const TESSEL_EXE = 'C:\\Program Files\\Tessel\\Tessel.exe'
const KPROCS = [
  { pid: 4, ppid: 0, created: '', name: 'System', exe: '', cmd: '' },
  { pid: 1188, ppid: 800, created: '100', name: 'svchost.exe', exe: 'C:\\Windows\\system32\\svchost.exe', cmd: 'svchost.exe -k RPCSS' },
  { pid: 7000, ppid: 50, created: '200', name: 'Tessel.exe', exe: TESSEL_EXE, cmd: `"${TESSEL_EXE}"` },
  { pid: 7100, ppid: 7000, created: '210', name: 'Tessel.exe', exe: TESSEL_EXE, cmd: `"${TESSEL_EXE}" --type=renderer` },
  { pid: 900, ppid: 7000, created: '220', name: 'Tessel.exe', exe: TESSEL_EXE, cmd: `"${TESSEL_EXE}" ptyHost.js` },
  { pid: 1000, ppid: 900, created: '300', name: 'pwsh.exe', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', cmd: 'pwsh.exe' },
  { pid: 2000, ppid: 900, created: '310', name: 'pwsh.exe', exe: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe', cmd: 'pwsh.exe' },
  { pid: 3000, ppid: 1000, created: '400', name: 'cmd.exe', exe: 'C:\\Windows\\system32\\cmd.exe', cmd: 'cmd /c npm run dev' },
  { pid: 4242, ppid: 3000, created: '410', name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node vite' },
  { pid: 5151, ppid: 2000, created: '420', name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node --inspect server.js' }
]
const SELF = { selfPids: [7000, 7100, 900], terminalHostPids: [900], selfExe: TESSEL_EXE, appRoots: ['C:\\Program Files\\Tessel'] }

// A scanner over fixed listings; processInfo answers from what is still alive.
function fixture({ raw = parseNetstatListening(NETSTAT), procs = KPROCS, ...over } = {}) {
  const alive = new Map(procs.map((p) => [p.pid, p]))
  const killer = vi.fn((pid) => alive.delete(pid))
  const deps = {
    listeners: vi.fn(async () => raw),
    processes: vi.fn(async () => procs),
    processInfo: vi.fn(async (pid) => ({ ok: true, proc: alive.get(pid) })),
    sleep: async () => {},
    ...over
  }
  return { scanner: createPortScanner(deps), killer, alive, deps }
}
const kill = (f, target, opts = {}) => f.scanner.kill({ probes: PROBES, ...target }, { killer: f.killer, ...SELF, ...opts })

describe('Stop Process', () => {
  it('stops that one process once its own fresh listing proves it owns the port in a copy', async () => {
    const f = fixture()
    expect(await kill(f, { pid: 4242, port: 5173 })).toEqual({ ok: true })
    expect(f.killer).toHaveBeenCalledTimes(1)
    expect(f.killer).toHaveBeenCalledWith(4242)
  })

  it('refuses a listener outside the workspaces, or a pid that is not on that port', async () => {
    const f = fixture()
    expect(await kill(f, { pid: 1188, port: 135 })).toMatchObject({ ok: false, reason: expect.stringMatching(/workspace/) })
    expect(await kill(f, { pid: 4242, port: 9229 })).toEqual({ ok: false, reason: 'The port is no longer listening.' })
    expect(await kill(f, { pid: 4242, port: 70000 })).toEqual({ ok: false, reason: 'Invalid process or port.' })
    expect(f.killer).not.toHaveBeenCalled()
  })

  // 1. A scan started before the request must not authorize the stop.
  it('does not trust a scan that was already running when the stop was asked', async () => {
    const raw = [{ host: '127.0.0.1', port: 5173, pid: 4242 }]
    let finish
    let calls = 0
    const f = fixture({
      listeners: vi.fn(async () => (++calls === 1 ? raw : [])), // the server has stopped since
      processes: vi.fn(() => new Promise((r) => (finish = r)))
    })
    const old = f.scanner.scan({ probes: PROBES })
    await Promise.resolve()
    const stopping = kill(f, { pid: 4242, port: 5173 })
    finish(KPROCS)
    await old
    expect(await stopping).toEqual({ ok: false, reason: 'The port is no longer listening.' })
    expect(calls).toBe(2)
    expect(f.killer).not.toHaveBeenCalled()
  })

  // 2. An incomplete listing never authorizes a stop.
  it('refuses when the processes or the ports cannot be listed', async () => {
    for (const processes of [async () => null, async () => Promise.reject(new Error('CIM failed')), async () => 'garbage']) {
      const f = fixture({ processes })
      expect(await kill(f, { pid: 4242, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/processes/) })
      expect(f.killer).not.toHaveBeenCalled()
    }
    for (const listeners of [async () => null, async () => Promise.reject(new Error('netstat failed'))]) {
      const f = fixture({ listeners })
      expect(await kill(f, { pid: 4242, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/listening ports/) })
      expect(f.killer).not.toHaveBeenCalled()
    }
  })

  it('refuses a pane shell pid on the port when the listing has no such process', async () => {
    const f = fixture({ raw: [{ host: '127.0.0.1', port: 5173, pid: 1000 }], procs: KPROCS.filter((p) => p.pid !== 1000) })
    expect(await kill(f, { pid: 1000, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/find that process/) })
    expect(f.killer).not.toHaveBeenCalled()
  })

  it('refuses a process it cannot identify (no creation time)', async () => {
    const procs = KPROCS.map((p) => (p.pid === 4242 ? { ...p, created: '' } : p))
    const f = fixture({ procs })
    expect(await kill(f, { pid: 4242, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/identify/) })
    expect(f.killer).not.toHaveBeenCalled()
  })

  // 3. Never one of Tessel's own processes.
  it("refuses Tessel's processes: main, a renderer, the terminal host, and what they run outside a terminal", async () => {
    // Each one listens on 5173 and names the copy's folder, so it is attributed to it.
    const cases = [
      { pid: 7000, ppid: 50, exe: TESSEL_EXE },
      { pid: 7100, ppid: 7000, exe: TESSEL_EXE },
      { pid: 900, ppid: 7000, exe: TESSEL_EXE },
      // A renderer of the dev build with an inspect port: electron.exe under the
      // copy, started by Tessel (not in a terminal).
      { pid: 7200, ppid: 7000, name: 'electron.exe', exe: 'C:\\repo\\node_modules\\electron\\dist\\electron.exe' },
      // Something Tessel's main process runs (not a terminal), any executable.
      { pid: 7300, ppid: 7000, name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe' },
      // ... or its grandchild.
      { pid: 7400, ppid: 7300, name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe' }
    ]
    const helper = { pid: 7300, ppid: 7000, created: '230', name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node mcp.js' }
    for (const c of cases) {
      const target = { created: '500', name: 'Tessel.exe', ...c, cmd: `"${c.exe}" --inspect=5173 C:\\repo\\x` }
      const procs = [...KPROCS.filter((p) => p.pid !== c.pid), ...(c.pid === 7300 ? [] : [helper]), target]
      const f = fixture({ raw: [{ host: '127.0.0.1', port: 5173, pid: c.pid }], procs })
      expect([c.pid, await kill(f, { pid: c.pid, port: 5173 })]).toEqual([c.pid, { ok: false, reason: 'Tessel cannot stop its own process.' }])
      expect(f.killer).not.toHaveBeenCalled()
    }
  })

  it("refuses Tessel's executable and anything in Tessel's folders, whoever started it", async () => {
    const devExe = 'C:\\Tessel\\node_modules\\electron\\dist\\electron.exe'
    for (const [exe, opts] of [
      [TESSEL_EXE, {}],
      ['C:\\Program Files\\Tessel\\resources\\helper.exe', {}],
      [devExe, { selfExe: devExe, appRoots: ['C:\\Tessel\\node_modules\\electron\\dist', 'C:\\Tessel'] }],
      ['C:\\Tessel\\node_modules\\electron\\dist\\other.exe', { selfExe: devExe, appRoots: ['C:\\Tessel'] }]
    ]) {
      const procs = [...KPROCS, { pid: 8000, ppid: 1000, created: '600', name: path.win32.basename(exe), exe, cmd: `"${exe}" --inspect=5173` }]
      const f = fixture({ raw: [{ host: '127.0.0.1', port: 5173, pid: 8000 }], procs })
      expect(await kill(f, { pid: 8000, port: 5173 }, opts)).toEqual({ ok: false, reason: 'Tessel cannot stop its own process.' })
      expect(f.killer).not.toHaveBeenCalled()
    }
  })

  it("stops what runs in a terminal, even a pane that is not a workspace's, and ignores a reused parent pid", async () => {
    // 2500: a shell of the terminal host in no probe; the server names the copy's folder.
    const procs = [
      ...KPROCS,
      { pid: 2500, ppid: 900, created: '320', name: 'pwsh.exe', exe: 'pwsh.exe', cmd: 'pwsh.exe' },
      { pid: 8100, ppid: 2500, created: '700', name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node C:\\repo\\server.js' },
      // Its parent died; Windows gave that pid to Tessel's renderer later.
      { pid: 8200, ppid: 7100, created: '150', name: 'node.exe', exe: 'C:\\Program Files\\nodejs\\node.exe', cmd: 'node C:\\repo\\old.js' }
    ]
    const raw = [
      { host: '127.0.0.1', port: 5000, pid: 8100 },
      { host: '127.0.0.1', port: 5001, pid: 8200 }
    ]
    const f = fixture({ raw, procs })
    expect(await kill(f, { pid: 8100, port: 5000 })).toEqual({ ok: true })
    expect(await kill(f, { pid: 8200, port: 5001 })).toEqual({ ok: true })
    expect(f.killer.mock.calls).toEqual([[8100], [8200]])
  })

  // Checked again right before stopping.
  it('refuses when the pid now belongs to another process, the port was released, or the check fails', async () => {
    const reused = fixture({ processInfo: async (pid) => ({ ok: true, proc: { ...KPROCS.find((p) => p.pid === pid), created: '999' } }) })
    expect(await kill(reused, { pid: 4242, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/another process/) })

    let n = 0
    const released = fixture({ listeners: async () => (++n === 1 ? parseNetstatListening(NETSTAT) : []) })
    expect(await kill(released, { pid: 4242, port: 5173 })).toEqual({ ok: false, reason: 'The port is no longer listening.' })

    const failing = fixture({ processInfo: async () => ({ ok: false }) })
    expect(await kill(failing, { pid: 4242, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/check the process again/) })

    const gone = fixture({ processInfo: async () => ({ ok: true, proc: undefined }) })
    expect(await kill(gone, { pid: 4242, port: 5173 })).toEqual({ ok: false, reason: 'The process has already exited.' })

    for (const f of [reused, released, failing, gone]) expect(f.killer).not.toHaveBeenCalled()
  })

  it('reports honestly what happened after the stop', async () => {
    const stubborn = fixture()
    stubborn.killer.mockImplementation(() => {}) // still there afterwards
    expect(await kill(stubborn, { pid: 4242, port: 5173 })).toEqual({ ok: false, reason: 'Stop was requested, but the process is still running.' })

    const exited = fixture()
    exited.killer.mockImplementation(() => {
      throw Object.assign(new Error('no such process'), { code: 'ESRCH' })
    })
    expect(await kill(exited, { pid: 4242, port: 5173 })).toEqual({ ok: true, alreadyExited: true })

    const denied = fixture()
    denied.killer.mockImplementation(() => {
      throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' })
    })
    expect(await kill(denied, { pid: 4242, port: 5173 })).toMatchObject({ ok: false, reason: expect.stringMatching(/Access denied/) })
  })
})

describe('process listing for ports', () => {
  it('reads pid, parent, creation time, name, executable and command line', () => {
    const out = '\r\n4242\t3000\t133700000000000000\tnode.exe\tC:\\nodejs\\node.exe\tnode "a\tb"\r\n4\t0\t\tSystem\t\t\r\nWARNING: junk\r\n'
    expect(parseWindowsProcesses(out)).toEqual([
      { pid: 4242, ppid: 3000, created: '133700000000000000', name: 'node.exe', exe: 'C:\\nodejs\\node.exe', cmd: 'node "a\tb"' },
      { pid: 4, ppid: 0, created: '', name: 'System', exe: '', cmd: '' }
    ])
    expect(parsePsProcesses('  77     1 Mon Sep 28 10:00:00 2026 /usr/bin/node node server.js\n')).toEqual([
      { pid: 77, ppid: 1, created: 'Mon Sep 28 10:00:00 2026', name: 'node', exe: '', cmd: 'node server.js' }
    ])
  })

  it('isTesselProcess stops at a terminal', () => {
    const byPid = new Map(KPROCS.map((p) => [p.pid, p]))
    expect(isTesselProcess(byPid.get(4242), byPid, { ...SELF, shellPids: [1000, 2000] })).toBe(false)
    expect(isTesselProcess(byPid.get(1000), byPid, { ...SELF, shellPids: [1000] })).toBe(false)
    expect(isTesselProcess(byPid.get(7100), byPid, SELF)).toBe(true)
  })
})
