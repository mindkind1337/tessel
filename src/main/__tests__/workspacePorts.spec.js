// @vitest-environment node
import { describe, it, expect, vi } from 'vitest'
import {
  parseNetstatListening,
  parseLsofListening,
  parseAddressWithPort,
  attributePorts,
  createPortScanner,
  sanitizeProbes
} from '../workspacePorts'

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

  it('stops only a process that still owns the port in a copy', async () => {
    const scanner = createPortScanner({ listeners: async () => parseNetstatListening(NETSTAT), processes: async () => PROCS })
    const killer = vi.fn()
    expect(await scanner.kill({ probes: PROBES, pid: 1188, port: 135 }, { killer })).toEqual({
      ok: false,
      reason: 'The port is no longer listening.'
    })
    expect(await scanner.kill({ probes: PROBES, pid: 4242, port: 5173 }, { killer, selfPids: [4242] })).toMatchObject({ ok: false })
    expect(await scanner.kill({ probes: PROBES, pid: 4242, port: 5173 }, { killer, selfPids: [1] })).toEqual({ ok: true })
    expect(killer).toHaveBeenCalledWith(4242)
    expect(killer).toHaveBeenCalledTimes(1)
  })
})
