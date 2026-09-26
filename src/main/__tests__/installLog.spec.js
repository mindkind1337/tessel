// @vitest-environment node
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createInstallLogs, plainText, MARK_OK, MARK_FAILED } from '../installLog'

let dir
let results
let logs
beforeEach(() => {
  dir = fs.mkdtempSync(join(os.tmpdir(), 'tessel-installlog-'))
  results = []
  logs = createInstallLogs({ dir, appVersion: '9.9.9', notify: (r) => results.push(r) })
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('install logs', () => {
  it('records the output as plain text and ends on the success marker', () => {
    const { file } = logs.start({ paneId: 'pane-1', name: 'Kimi Code', shell: 'powershell', steps: ['irm x | iex'] })
    expect(file).toMatch(/installs[\\/]Kimi-Code-\d{8}-\d{6}\.log$/)
    logs.onData('pane-1', '\x1b[32mDownloading\x1b[0m 50%\r100%\n')
    logs.onData('pane-2', 'other pane output\n')
    logs.onData('pane-1', `TESSEL-INST`)
    logs.onData('pane-1', `ALL-OK\r\n`) // a marker cut in two chunks
    expect(results).toEqual([{ paneId: 'pane-1', name: 'Kimi Code', ok: true, reason: '', file }])
    const text = fs.readFileSync(file, 'utf8')
    expect(text).toContain('Tessel 9.9.9 install log')
    expect(text).toContain('  irm x | iex')
    expect(text).toContain('Downloading 50%\n100%')
    expect(text).not.toContain('\x1b')
    expect(text).not.toContain('other pane output')
    expect(text).toContain('===== SUCCEEDED')
    // Ended: later output is not logged, no second result.
    logs.onData('pane-1', `${MARK_FAILED}\n`)
    expect(results).toHaveLength(1)
  })

  it('a failure marker, or the terminal closing first, is a failure', () => {
    logs.start({ paneId: 'a', name: 'Aider', steps: ['pip install x'] })
    logs.onData('a', `ERROR: No matching distribution\n${MARK_FAILED}\n`)
    logs.start({ paneId: 'b', name: 'Amp', steps: ['npm i -g amp'] })
    logs.onExit('b', 1)
    expect(results.map((r) => [r.paneId, r.ok, r.reason])).toEqual([
      ['a', false, ''],
      ['b', false, 'the terminal closed (exit code 1)']
    ])
    expect(fs.readFileSync(results[0].file, 'utf8')).toContain('No matching distribution')
  })

  it('only its own log files can be opened', () => {
    const { file } = logs.start({ paneId: 'p', name: 'X' })
    expect(logs.isLog(file)).toBe(true)
    expect(logs.isLog(join(dir, 'installs', '..', 'tessel.log'))).toBe(false)
    expect(logs.isLog('C:\\Windows\\win.ini')).toBe(false)
    expect(MARK_OK).not.toContain(MARK_FAILED)
  })

  it('plain text: colors, titles and cursor moves removed', () => {
    expect(plainText('\x1b]0;title\x07a\x1b[2K\x1b[1Gb')).toBe('ab')
  })
})
