// The Agent Session History panel's logic (src/renderer/src/sessionHistory.js):
// view options, filters, grouping, counts, times, Delete's reasons.
import { describe, it, expect, afterEach } from 'vitest'
import {
  AGENTS,
  DEFAULT_SESSION_LIMIT,
  countViewAdjustments,
  defaultViewOptions,
  deleteBlockedReason,
  filterSessions,
  folderKey,
  folderLabel,
  groupSessions,
  hitRow,
  inFolder,
  loadViewOptions,
  normalizeViewOptions,
  resultCountLabel,
  saveViewOptions,
  sessionCountLabel,
  showMoreAvailable,
  snippetParts,
  timeAgo
} from '../sessionHistory'
import { setMessages } from '../i18n'

const S = (over = {}) => ({ agent: 'claude', id: 'a1', cwd: 'C:\\Tessel', title: 'Fix the build', started: 100, updated: 200, ...over })

afterEach(() => setMessages('en', {}))

describe('view options', () => {
  it('are made valid from whatever was saved, with their defaults', () => {
    expect(normalizeViewOptions(null)).toEqual(defaultViewOptions())
    const o = normalizeViewOptions({ agents: ['codex', 'nope', 'claude'], sort: 'created', searchSort: 'x', group: 'agent', limit: 7 })
    expect(o.agents).toEqual(['claude', 'codex']) // in the catalog's order, unknown dropped
    expect(o.sort).toBe('created')
    expect(o.searchSort).toBe('relevance')
    expect(o.group).toBe('agent')
    expect(o.limit).toBe(DEFAULT_SESSION_LIMIT)
  })

  it('counts the adjustments the view menu badge shows (sorts excluded)', () => {
    expect(countViewAdjustments(defaultViewOptions())).toBe(0)
    expect(countViewAdjustments({ ...defaultViewOptions(), sort: 'created' })).toBe(0)
    expect(countViewAdjustments({ ...defaultViewOptions(), agents: AGENTS.filter((a) => a !== 'codex'), group: 'agent', limit: 100 })).toBe(3)
  })

  it('persist in storage and come back valid', () => {
    const store = new Map()
    const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) }
    saveViewOptions({ ...defaultViewOptions(), group: 'agent', limit: 200 }, storage)
    expect(loadViewOptions(storage)).toMatchObject({ group: 'agent', limit: 200 })
    store.set('tessel.sessionHistory.view', '{not json')
    expect(loadViewOptions(storage)).toEqual(defaultViewOptions())
    expect(loadViewOptions(null)).toEqual(defaultViewOptions())
  })
})

describe('folders', () => {
  it('one spelling per folder; a folder and what is under it', () => {
    expect(folderKey('C:\\Tessel\\src\\')).toBe('c:/tessel/src')
    expect(inFolder('C:\\Tessel\\src', 'c:/tessel')).toBe(true)
    expect(inFolder('C:\\Tessel', 'C:\\Tessel\\')).toBe(true)
    expect(inFolder('C:\\Tessel-claude\\x', 'C:\\Tessel')).toBe(false)
    expect(inFolder('', 'C:\\Tessel')).toBe(false)
  })

  it('labels a folder by its last two segments', () => {
    expect(folderLabel('C:\\Users\\me\\Tessel')).toBe('me/Tessel')
    expect(folderLabel('/srv')).toBe('srv')
    expect(folderLabel('')).toBe('Unknown location')
  })
})

describe('filterSessions', () => {
  const list = [
    S({ id: 'a1', updated: 300, started: 50 }),
    S({ id: 'a2', agent: 'codex', cwd: 'C:\\Tessel\\sub', title: 'Rename things', updated: 200, started: 150 }),
    S({ id: 'a3', agent: 'gemini', cwd: 'D:\\other', title: 'Elsewhere', updated: 100, started: 10 })
  ]

  it('keeps the chosen agents, in the scope, newest first', () => {
    expect(filterSessions(list, { agents: ['claude', 'codex', 'gemini'] }).map((s) => s.id)).toEqual(['a1', 'a2', 'a3'])
    expect(filterSessions(list, { agents: ['codex'] }).map((s) => s.id)).toEqual(['a2'])
    expect(filterSessions(list, { scope: 'workspace', cwd: 'c:/tessel' }).map((s) => s.id)).toEqual(['a1'])
    expect(filterSessions(list, { scope: 'project', cwd: 'C:\\Tessel' }).map((s) => s.id)).toEqual(['a1', 'a2'])
    // No folder: a scoped view shows nothing rather than everything.
    expect(filterSessions(list, { scope: 'workspace', cwd: null })).toEqual([])
  })

  it('sorts by creation when asked, and matches every word of the query', () => {
    expect(filterSessions(list, { sort: 'created' }).map((s) => s.id)).toEqual(['a2', 'a1', 'a3'])
    expect(filterSessions(list, { query: 'rename codex' }).map((s) => s.id)).toEqual(['a2'])
    expect(filterSessions(list, { query: 'Gemini' }).map((s) => s.id)).toEqual(['a3']) // the agent's label
    expect(filterSessions(list, { query: 'rename elsewhere' })).toEqual([])
  })
})

describe('groups, counts, more', () => {
  it('groups by folder (one spelling) or by agent, keeping the order', () => {
    const list = [S({ id: '1', cwd: 'C:\\Tessel' }), S({ id: '2', cwd: 'c:/tessel/' }), S({ id: '3', agent: 'codex', cwd: '' })]
    const byFolder = groupSessions(list, 'folder')
    expect(byFolder.map((g) => [g.label, g.sessions.length])).toEqual([
      ['C:/Tessel', 2],
      ['Unknown location', 1]
    ])
    expect(groupSessions(list, 'agent').map((g) => g.label)).toEqual(['Claude Code', 'Codex'])
  })

  it('offers Show more once an agent filled the depth, up to the cap', () => {
    const list = [S({ id: '1' }), S({ id: '2' }), S({ id: '3', agent: 'codex' })]
    expect(showMoreAvailable(list, 2)).toBe(true)
    expect(showMoreAvailable(list, 3)).toBe(false)
    expect(showMoreAvailable(list, 200)).toBe(false)
    expect(showMoreAvailable([], 2)).toBe(false)
  })

  it('labels the bar', () => {
    expect(sessionCountLabel(1, 1)).toBe('1 session')
    expect(sessionCountLabel(3, 3)).toBe('3 sessions')
    expect(sessionCountLabel(2, 5)).toBe('2 of 5 sessions')
    expect(resultCountLabel(1)).toBe('1 result')
    expect(resultCountLabel(4)).toBe('4 results')
    setMessages('fr', { sessionHistory: { bar: { sessions_one: '{{count}} session', sessions_other: '{{count}} sessions', sessionsOfLoaded: '{{shown}} sur {{loaded}} sessions' } } })
    expect(sessionCountLabel(3, 3)).toBe('3 sessions')
    expect(sessionCountLabel(2, 5)).toBe('2 sur 5 sessions')
  })
})

describe('timeAgo', () => {
  it('reads like Orca', () => {
    const now = 1_000_000_000_000
    expect(timeAgo(now - 10_000, now)).toBe('Just now')
    expect(timeAgo(now - 5 * 60_000, now)).toBe('5m ago')
    expect(timeAgo(now - 3 * 3_600_000, now)).toBe('3h ago')
    expect(timeAgo(now - 2 * 86_400_000, now)).toBe('2d ago')
    expect(timeAgo(now - 45 * 86_400_000, now)).toBe('1mo ago')
    expect(timeAgo(now - 400 * 86_400_000, now)).toBe('1y ago')
    expect(timeAgo(0, now)).toBe('Unknown time')
  })
})

describe('deleteBlockedReason', () => {
  it('blocks a session open in a pane, and the agents whose history is not a file of its own', () => {
    expect(deleteBlockedReason(S())).toBe(null)
    expect(deleteBlockedReason(S(), { a1: 'pane-1' })).toMatch(/open in a pane/)
    expect(deleteBlockedReason(S({ agent: 'codex' }))).toBe("Codex sessions can't be deleted from Tessel.")
    expect(deleteBlockedReason(S({ agent: 'grok' }))).toBe(null)
  })
})

describe('search hits', () => {
  it('become rows with their marked passage, secrets masked', () => {
    const row = hitRow({ agent: 'codex', sessionId: 's1', cwd: 'C:\\x', title: 'T', updatedAt: 5, messageCount: 9, evidence: { role: 'assistant', snippet: 'a \uE000hit\uE001 b' } })
    expect(row).toMatchObject({ agent: 'codex', id: 's1', updated: 5, messageCount: 9 })
    expect(row.evidence.role).toBe('assistant')
    expect(row.evidence.parts).toEqual([
      { text: 'a ', match: false },
      { text: 'hit', match: true },
      { text: ' b', match: false }
    ])
    expect(hitRow({ agent: 'codex', sessionId: 's2', title: '' }).title).toBe('Untitled conversation')
    // A stray closing mark is dropped; nothing else is lost.
    expect(snippetParts('plain \uE001text')).toEqual([{ text: 'plain text', match: false }])
  })
})
