// The conversations each terminal agent pane was in while Tessel runs
// (src/renderer/src/paneSessionTrail.js), for the Conversations tab.
import { describe, it, expect, vi } from 'vitest'
import { notePanes, confirmSession, sessionIds, SETTLE_MS, MAX_SESSIONS, clearPaneSessionTrail, paneSessionTrail, restorePaneSessionTrail } from '../paneSessionTrail'

const pane = (sessionId, extra = {}) => ({
  id: 'p1',
  kind: 'agent',
  agentId: 'claude',
  title: 'Ada',
  sessionId,
  ...extra
})
const ws = (...panes) => [{ id: 'ws1', panes }]

describe('paneSessionTrail', () => {
  it('an id corrected at once is not kept; one it read, or one that stayed, is', () => {
    const trail = {}
    notePanes(ws(pane('wrong')), 0, trail)
    notePanes(ws(pane('right')), 1000, trail)
    expect(sessionIds(trail.p1)).toEqual(['right'])
    confirmSession('p1', 'right', trail)
    notePanes(ws(pane('after-clear')), 2000, trail)
    expect(sessionIds(trail.p1)).toEqual(['right', 'after-clear'])
    notePanes(ws(pane('next')), 2000 + SETTLE_MS, trail)
    expect(sessionIds(trail.p1)).toEqual(['right', 'after-clear', 'next'])
    for (let i = 0; i < 5; i++) notePanes(ws(pane(`s${i}`)), 10 * SETTLE_MS * (i + 1), trail)
    expect(sessionIds(trail.p1)).toHaveLength(MAX_SESSIONS)
  })

  it('a pane that became a chat is not closed; one gone is', () => {
    const trail = {}
    notePanes(ws(pane('a'), { ...pane('b'), id: 'p2' }), 0, trail)
    notePanes(ws({ ...pane('a'), kind: 'chat' }), 5000, trail)
    expect(trail.p1).toMatchObject({ chat: true, closedAt: 0 })
    expect(trail.p2.closedAt).toBe(5000)
    // Back to its terminal: read again.
    notePanes(ws(pane('a')), 6000, trail)
    expect(trail.p1).toMatchObject({ chat: false, closedAt: 0 })
    expect(sessionIds(trail.p1)).toEqual(['a'])
  })

  it('nothing changed: nothing written', () => {
    const trail = {}
    notePanes(ws(pane('a')), 0, trail)
    const row = trail.p1
    notePanes(ws(pane('a')), 9000, trail)
    expect(trail.p1).toBe(row)
  })
})

describe('kept across restarts', () => {
  it('writes the trail to the window storage and reads it back', async () => {
    vi.useFakeTimers()
    try {
      clearPaneSessionTrail()
      notePanes([{ id: 'ws1', panes: [{ id: 'pk', kind: 'agent', agentId: 'claude', title: 'Ada', sessionId: 'kept-1' }] }], 1000)
      vi.advanceTimersByTime(1500)
      const raw = localStorage.getItem('tessel.conversations.paneTrail')
      expect(JSON.parse(raw).pk.sessions.map((x) => x.id)).toEqual(['kept-1'])
      for (const id of Object.keys(paneSessionTrail)) delete paneSessionTrail[id]
      restorePaneSessionTrail()
      expect(sessionIds(paneSessionTrail.pk)).toEqual(['kept-1'])
      localStorage.setItem('tessel.conversations.paneTrail', '{"x":{"paneId":1}}')
      for (const id of Object.keys(paneSessionTrail)) delete paneSessionTrail[id]
      restorePaneSessionTrail()
      expect(Object.keys(paneSessionTrail)).toEqual([])
      clearPaneSessionTrail()
      expect(localStorage.getItem('tessel.conversations.paneTrail')).toBe(null)
    } finally {
      vi.useRealTimers()
    }
  })
})
