// @vitest-environment node
// The record of the OpenCode servers chat panes started, and the clean-up of
// the ones a crashed Tessel left (never a process that is not ours).
import { describe, it, expect } from 'vitest'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createServerPidFile, reapOpencodeServers, isOurServer } from '../opencodeServers'

const SERVE = '"C:\\npm\\node_modules\\opencode-ai\\bin\\opencode.exe" serve --hostname 127.0.0.1 --port 0'

describe('OpenCode server records', () => {
  it('adds and removes PIDs', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tessel-oc-pids-')), 'd', 'servers.json')
    const pids = createServerPidFile({ file })
    pids.add(10)
    pids.add(11)
    pids.add(-1)
    pids.add(10)
    expect(pids.list()).toEqual([10, 11])
    pids.remove(10)
    expect(pids.list()).toEqual([11])
    writeFileSync(file, 'not json')
    expect(pids.list()).toEqual([])
  })

  it('recognizes only our server command line on opencode.exe', () => {
    expect(isOurServer({ name: 'opencode.exe', commandLine: SERVE })).toBe(true)
    expect(isOurServer({ name: 'OpenCode.exe', commandLine: '"C:\\Program Files\\OpenCode\\OpenCode.exe"' })).toBe(false)
    expect(isOurServer({ name: 'opencode.exe', commandLine: 'opencode.exe serve --hostname 0.0.0.0 --port 0' })).toBe(false)
    expect(isOurServer({ name: 'opencode.exe', commandLine: 'opencode.exe acp' })).toBe(false)
    expect(isOurServer({ name: 'notepad.exe', commandLine: SERVE })).toBe(false)
    expect(isOurServer({})).toBe(false)
  })

  it('stops recorded leftovers that are still our servers, leaves the others, keeps new records', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tessel-oc-reap-')), 'servers.json')
    const pids = createServerPidFile({ file })
    for (const p of [100, 101, 102, 103]) pids.add(p)
    const killed = []
    const stopped = await reapOpencodeServers({
      file,
      describe: async (list) => {
        expect(list).toEqual([100, 101, 102, 103])
        // A chat started meanwhile records its own server.
        pids.add(200)
        return [
          { pid: 100, name: 'opencode.exe', commandLine: SERVE },
          { pid: 101, name: 'chrome.exe', commandLine: 'chrome.exe' }, // PID reused
          { pid: 102, name: 'opencode.exe', commandLine: 'opencode.exe' }, // the user's TUI
          { pid: 999, name: 'opencode.exe', commandLine: SERVE } // not recorded
        ]
      },
      kill: async (pid) => killed.push(pid)
    })
    expect(stopped).toEqual([100])
    expect(killed).toEqual([100])
    expect(JSON.parse(readFileSync(file, 'utf8')).pids).toEqual([200])
  })

  it('nothing recorded: nothing listed', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'tessel-oc-reap0-')), 'servers.json')
    let asked = false
    expect(await reapOpencodeServers({ file, describe: async () => ((asked = true), []) })).toEqual([])
    expect(asked).toBe(false)
  })
})
