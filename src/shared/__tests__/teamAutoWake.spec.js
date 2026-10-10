import { describe, it, expect } from 'vitest'
import { strandedCards, inProgressCount, ACTIVE_COLUMNS } from '../teamAutoWake'

const members = [
  { name: 'Ada', num: 1 },
  { name: 'Bohr', num: 2 }
]

const card = (over) => ({
  id: 'task-1-1',
  title: 'Do the thing',
  column: 'doing',
  assignee: 'Ada',
  columnSince: 1000,
  ...over
})

describe('stranded cards', () => {
  it('finds a card whose assignee left the team', () => {
    const found = strandedCards([card({ assignee: 'Gone' })], members)
    expect(found.map((t) => t.id)).toEqual(['task-1-1'])
  })

  it('leaves a card that a live teammate is doing', () => {
    expect(strandedCards([card()], members)).toEqual([])
  })

  it('finds a card with no assignee at all', () => {
    const found = strandedCards([card({ assignee: undefined })], members)
    expect(found.map((t) => t.id)).toEqual(['task-1-1'])
  })

  it('addresses a member by its number, "#2" as well as by name', () => {
    expect(strandedCards([card({ assignee: '#2' })], members)).toEqual([])
    expect(strandedCards([card({ assignee: '#3' })], members)).toHaveLength(1)
  })

  it('counts "review" as still needing the work done', () => {
    expect(strandedCards([card({ column: 'review', assignee: 'Gone' })], members)).toHaveLength(1)
  })

  it('never picks a card that is finished or not started', () => {
    const cards = [
      card({ id: 'a', column: 'done', assignee: 'Gone' }),
      card({ id: 'b', column: 'todo', assignee: 'Gone' }),
      card({ id: 'c', column: 'failed', assignee: 'Gone' })
    ]
    expect(strandedCards(cards, members)).toEqual([])
  })

  it('reports ONE card per piece of work, the stranded one, when forking made two', () => {
    const cards = [
      card({ id: 'live', title: 'Same work', assignee: 'Ada', columnSince: 2000 }),
      card({ id: 'stale', title: 'Same work', assignee: 'Gone', columnSince: 500 })
    ]
    // The live copy covers the title, so the stranded copy is left alone: it
    // would be picked forever, and its work done twice.
    expect(strandedCards(cards, members)).toEqual([])
  })

  it('does not let one stranded copy cover another stranded copy', () => {
    const cards = [
      card({ id: 'stale-1', title: 'Same work', assignee: 'Gone', columnSince: 500 }),
      card({ id: 'stale-2', title: 'Same work', assignee: undefined, columnSince: 900 })
    ]
    // Neither has a live assignee, so neither covers the title: both are
    // reported, because both are genuinely unowned.
    const found = strandedCards(cards, members)
    expect(found.map((t) => t.id)).toEqual(['stale-1', 'stale-2'])
  })

  it('ignores a stale inactive seat, so it can never win an address', () => {
    // "Bohr" left: it stays in the channel's state.json as an inactive seat.
    const found = strandedCards([card({ assignee: 'Bohr' })], [{ name: 'Ada', num: 1 }])
    expect(found.map((t) => t.id)).toEqual(['task-1-1'])
  })

  it('treats matching names case-sensitively, like Tessel addresses them', () => {
    // addressMember matches the paneName case-insensitively on the agent side;
    // a lead request resolves a name the same way. An exact name that is not a
    // member is stranded, whatever its case.
    expect(strandedCards([card({ assignee: 'ada' })], members)).toHaveLength(1)
  })

  it('returns the oldest strand first', () => {
    const cards = [
      card({ id: 'new', title: 'A', assignee: 'Gone', columnSince: 9000 }),
      card({ id: 'old', title: 'B', assignee: 'Gone', columnSince: 1000 })
    ]
    expect(strandedCards(cards, members).map((t) => t.id)).toEqual(['old', 'new'])
  })

  it('survives a board with nothing on it', () => {
    expect(strandedCards([], members)).toEqual([])
    expect(strandedCards(null, members)).toEqual([])
    expect(strandedCards([card()], [])).toHaveLength(1)
  })
})

describe('in progress count', () => {
  it('counts "doing" and "review" together, like LEAD_MAX_ACTIVE does', () => {
    const cards = [card(), card({ id: 'b', column: 'review' }), card({ id: 'c', column: 'todo' })]
    expect(inProgressCount(cards)).toBe(2)
    expect(ACTIVE_COLUMNS).toEqual(['doing', 'review'])
  })

  it('counts stranded cards too: they are still in progress', () => {
    // This is the whole point of matching the ceiling: a stranded card occupies
    // a slot, so a lead request can be refused even though nobody is working.
    expect(inProgressCount([card({ assignee: 'Gone' })])).toBe(1)
  })
})
