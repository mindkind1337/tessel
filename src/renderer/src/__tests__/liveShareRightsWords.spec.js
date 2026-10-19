// Live Share rights in the window (src/renderer/src/liveShareRights.js): every
// right of the shared catalog has its words, the boxes follow the catalog's
// order, and a right without words is never shown. Also the access views'
// helpers (liveShareAccess.js).
import { describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { RIGHT_IDS } from '../../../shared/liveShareRights'
import { hasRightWords, rightWords, shownRights, rightsShort, presetLabel, presetRights, rightsSummary } from '../liveShareRights'
import { initials, inviteName, inviteUses, inviteExpiry, grantDiff, accessPeople, accessError, joinedGuests, offlinePeople } from '../liveShareAccess'
import RightsChecks from '../components/liveshare/RightsChecks.vue'

describe('rights: words for the catalog', () => {
  it('every right of the catalog has a label, a short label and a hint', () => {
    for (const id of RIGHT_IDS) {
      expect(hasRightWords(id)).toBe(true)
      const w = rightWords(id)
      expect(w.label.length).toBeGreaterThan(3)
      expect(w.short.length).toBeGreaterThan(1)
      expect(w.hint.length).toBeGreaterThan(3)
    }
    expect(shownRights().map((r) => r.id)).toEqual([...RIGHT_IDS])
  })

  it('the open right says what it means', () => {
    expect(rightWords('open').label).toBe('Open terminals and agents on your computer (they can run commands)')
  })

  it('every label is an action, in the same form (no "Can open…" among them)', () => {
    for (const r of shownRights()) expect(r.label).not.toMatch(/^Can /)
  })

  it('Type is the one right marked as running commands as you, and comes first', () => {
    expect(shownRights()[0].id).toBe('type')
    expect(shownRights().filter((r) => r.danger).map((r) => r.id)).toEqual(['type'])
  })

  it('a right without words is never shown; unknown ids are not words', () => {
    expect(rightWords('made-up')).toBe(null)
    expect(hasRightWords('__proto__')).toBe(false)
    const w = mount(RightsChecks, { props: { rights: { type: true, made: true } } })
    expect(w.findAll('input').length).toBe(RIGHT_IDS.length)
    expect(w.findAll('input').map((x) => x.element.checked)).toEqual(RIGHT_IDS.map((id) => id === 'type'))
  })

  it('a box asks for the change and shows what the subject has until it comes back', async () => {
    const w = mount(RightsChecks, { props: { rights: { type: false }, testKey: 'x' } })
    const box = w.find('[data-test="ls-right-type-x"] input')
    box.element.checked = true
    await box.trigger('change')
    expect(w.emitted('toggle')).toEqual([['type', true]])
    expect(box.element.checked).toBe(false)
  })

  it('a short summary', () => {
    expect(rightsShort({ type: true, open: true })).toBe('Type, Open')
    expect(rightsShort({})).toBe('Watch only')
  })

  it('presets by name, and one chip for anyone’s rights', () => {
    expect(['view', 'collaborate', 'full', 'custom'].map(presetLabel)).toEqual(['View only', 'Collaborate', 'Full control', 'Custom'])
    expect(rightsSummary({})).toMatchObject({ preset: 'view', text: 'View only', danger: false })
    expect(rightsSummary(presetRights('collaborate'))).toMatchObject({ preset: 'collaborate', text: 'Collaborate', danger: false })
    expect(rightsSummary(presetRights('full'))).toMatchObject({ preset: 'full', text: 'Full control', danger: true })
    expect(rightsSummary({ open: true, edit: true, git: true, tasks: true })).toMatchObject({ preset: 'custom', text: 'Custom · 4', title: 'Open, Edit, Git, Tasks' })
    expect(rightsSummary({ type: true }).danger).toBe(true)
  })
})

describe('access views: helpers', () => {
  it('initials', () => {
    expect(initials('Simpa')).toBe('SI')
    expect(initials('Jean Claude')).toBe('JC')
    expect(initials('  ')).toBe('?')
    expect(initials('élodie')).toBe('ÉL')
  })

  it('an invitation’s name, uses and expiry', () => {
    expect(inviteName({ label: ' Team ' })).toBe('Team')
    expect(inviteName({ label: '', root: true })).toBe('First invite code')
    expect(inviteName({ label: '' })).toBe('Invitation')
    expect(inviteUses({ uses: 3, maxUses: 10 })).toBe('3 of 10 uses')
    expect(inviteUses({ uses: 0, maxUses: 0 })).toBe('0 uses, no limit')
    expect(inviteExpiry({ expiresAt: null }).text).toBe('No expiry')
    expect(inviteExpiry({ expiresAt: 1000 }, 2000)).toMatchObject({ text: 'Expired', expired: true })
  })

  it('what a change takes away and adds', () => {
    expect(grantDiff({ projects: ['a', 'b'], rights: { type: true, open: false } }, { projects: ['b', 'c'], rights: { type: false, open: true } })).toEqual({
      removedProjects: ['a'],
      addedProjects: ['c'],
      removedRights: ['type'],
      addedRights: ['open']
    })
  })

  it('everyone with access, a trusted person offline once', () => {
    const rows = accessPeople({
      guests: [{ id: 'g1', name: 'Bob', state: 'joined', projects: ['a'] }, { id: 'g2', name: 'Eve', state: 'waiting' }],
      offline: [{ id: 'k-1', name: 'Al', projects: [] }, { id: 'k-2', name: 'Ty', projects: ['a'], trusted: true }],
      trusted: [{ id: 't-1', name: 'Ty', projects: ['a'], online: false }, { id: 't-2', name: 'Bob', online: true }]
    })
    expect(rows.map((r) => [r.id, r.kind])).toEqual([
      ['g1', 'guest'],
      ['k-1', 'offline'],
      ['t-1', 'trusted']
    ])
  })

  it('a trusted person’s replaced connection shows once (the newest), and not as offline too', () => {
    const host = {
      guests: [
        { id: 'g1', name: 'Tess', state: 'joined', trustId: 't-1', since: 1, projects: [] },
        { id: 'g2', name: 'Tess', state: 'joined', trustId: 't-1', since: 2, projects: [] }
      ],
      offline: [{ id: 'k-1', name: 'Tess', trustId: 't-1', trusted: true, projects: [] }, { id: 'k-2', name: 'Al', trustId: null, projects: [] }],
      trusted: [{ id: 't-1', name: 'Tess', projects: [], online: true }]
    }
    expect(joinedGuests(host).map((g) => g.id)).toEqual(['g2'])
    expect(offlinePeople(host).map((p) => p.id)).toEqual(['k-2'])
    expect(accessPeople(host).map((r) => r.id)).toEqual(['g2', 'k-2'])
  })

  it('refusals in words', () => {
    expect(accessError({ ok: false, reason: 'not-sharing' })).toBe('Start sharing first.')
    expect(accessError({ ok: false, reason: 'auto-allow' })).toMatch(/needs your yes/)
    expect(accessError(null, 'Fallback.')).toBe('Fallback.')
    expect(accessError({ ok: false, reason: 'trust-full' })).toBe('Trusted list is full (50): remove someone first.')
  })
})
