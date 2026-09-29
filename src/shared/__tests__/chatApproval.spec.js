// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { approvalText, approvalPreview, MAX_DETAIL } from '../chatApproval'

describe('approval card text', () => {
  it("Claude's Bash input: the command alone", () => {
    expect(approvalText({ command: 'rm x', description: 'Remove' })).toBe('rm x')
  })

  it('a Codex command: what runs (rawCommand) first, its cwd, then the parsed reading', () => {
    const input = { command: 'node -e 1', rawCommand: 'powershell.exe -Command "node -e 1; rm -r C:\\\\"', cwd: 'C:\\w' }
    expect(approvalText(input).split('\n')).toEqual(['powershell.exe -Command "node -e 1; rm -r C:\\\\"', 'cwd: C:\\w', 'parsed: node -e 1'])
  })

  it('a Codex command with no rawCommand: the command and its cwd, no parsed line', () => {
    expect(approvalText({ command: 'ls', cwd: 'C:\\w' })).toBe('ls\ncwd: C:\\w')
  })

  it('what widens the request is a line of its own', () => {
    const text = approvalText({
      command: 'curl x',
      cwd: 'C:\\w',
      proposedExecpolicyAmendment: ['curl', 'x'],
      additionalPermissions: { network: true },
      networkApprovalContext: { host: 'example.org' }
    })
    expect(text).toContain('\nproposedExecpolicyAmendment: ["curl","x"]')
    expect(text).toContain('\nadditionalPermissions: {"network":true}')
    expect(text).toContain('\nnetworkApprovalContext: {"host":"example.org"}')
  })

  it('hidden is counted over the whole text: a long rawCommand behind a short parsed one', () => {
    const rawCommand = 'powershell -Command "echo hi; ' + 'x'.repeat(MAX_DETAIL) + '; del C:\\*"'
    const input = { command: 'echo hi', rawCommand, cwd: 'C:\\w' }
    const full = approvalText(input)
    const { detail, hidden } = approvalPreview(input)
    expect(hidden).toBe(full.length - MAX_DETAIL)
    expect(hidden).toBeGreaterThan(0)
    expect(detail + full.slice(MAX_DETAIL)).toBe(full)
    expect(full.endsWith('parsed: echo hi')).toBe(true)
  })

  it('changes unknown: counted as not all seen, the new write root shown first', () => {
    const input = { grantRoot: 'C:\\elsewhere', changesUnknown: true, file_path: '', changes: [] }
    const { detail, hidden } = approvalPreview(input)
    expect(hidden).toBe(1)
    expect(detail.indexOf('grantRoot')).toBeLessThan(detail.indexOf('changes"'))
    expect(approvalPreview({ file_path: 'a', changes: [{ path: 'a' }] }).hidden).toBe(0)
  })
})
