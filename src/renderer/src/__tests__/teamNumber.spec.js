// Team numbers and default names (teamNumber.js).
import { afterEach, describe, expect, it } from 'vitest'
import { setMessages } from '../i18n'
import { dedupeTeamNumbers, teamNumber } from '../teamNumber.js'

afterEach(() => setMessages('en', {}))
const names = (list) => list.map((x) => x.name)

describe('team numbers', () => {
  it('a short mark: the name\'s last number, else its first two letters', () => {
    expect(teamNumber('Team 2')).toBe('2')
    expect(teamNumber('Équipe 12')).toBe('12')
    expect(teamNumber('Backend')).toBe('Ba')
  })

  it('a default name follows the language in use; a name the user gave is kept', () => {
    const list = [{ id: 'a', name: 'Équipe 1' }, { id: 'b', name: 'Team 2' }, { id: 'c', name: 'Backend' }]
    expect(names(dedupeTeamNumbers(list))).toEqual(['Team 1', 'Team 2', 'Backend'])
    setMessages('fr', { app: { team: { defaultName: 'Équipe {{n}}' } } })
    expect(names(dedupeTeamNumbers(list))).toEqual(['Équipe 1', 'Équipe 2', 'Backend'])
  })

  it('two teams never show the same number: the later one takes the next free one', () => {
    expect(names(dedupeTeamNumbers([{ id: 'a', name: 'Team 2' }, { id: 'b', name: 'Équipe 2' }, { id: 'c', name: 'Team 1' }]))).toEqual(['Team 2', 'Team 1', 'Team 3'])
  })

  it('nothing to change: the same list back (no save, no re-render)', () => {
    const list = [{ id: 'a', name: 'Team 1' }, { id: 'b', name: 'Backend' }]
    expect(dedupeTeamNumbers(list)).toBe(list)
  })
})
