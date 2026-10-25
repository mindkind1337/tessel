// Where a Codex rollout is on a host: the day folders its UUIDv7 id names,
// looked at before a search of the whole sessions folder.
import { describe, it, expect } from 'vitest'
import { codexDayHint } from '../codexDayHint'
import { requestScript } from '../../remoteShell'

describe('codexDayHint', () => {
  it('a UUIDv7: its day first, then the days before and after (the host\'s time zone is not known)', () => {
    // 0x01a16f50626f ms = 2026-10-24T19:08:21Z (a conversation started then).
    const id = '01a16f50-626f-7a13-9795-0e1e34414ed7'
    const ms = parseInt('01a16f50626f', 16)
    expect(new Date(ms).toISOString().slice(0, 10)).toBe('2026-10-24')
    expect(codexDayHint(id, ms)).toBe('2026/10/24:2026/10/23:2026/10/25')
  })

  it('anything else gives no hint (the whole folder is searched as before)', () => {
    for (const id of ['', 'abc', 'not-a-uuid', '01a16f50-626f-4a13-9795-0e1e34414ed7', '00000000-0000-7000-8000-000000000000', '01a16f50-626f-7a13-c795-0e1e34414ed7'])
      expect(codexDayHint(id)).toBe('')
    // A time in the future past tomorrow: not a session's.
    expect(codexDayHint('7fffffff-ffff-7fff-bfff-ffffffffffff', Date.UTC(2026, 9, 25))).toBe('')
  })

  it('goes to the host as one plain argument (digits, slashes, colons)', () => {
    const hint = codexDayHint('01a16f50-626f-7a13-9795-0e1e34414ed7')
    expect(hint).toMatch(/^[0-9/:]+$/)
    expect(requestScript(1, 10, '__t_tread', ['codex', '01a16f50-626f-7a13-9795-0e1e34414ed7', '-', '10', hint])).toContain(`'${hint}'`)
  })
})
