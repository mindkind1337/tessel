// Live Share's dialog (LiveShareDialog.vue): Share (one page: who asks to
// come in, the projects shared and their picker, the people, the
// invitation; a person, Invitations and Settings as pages of their own)
// and Join, against a
// fake window.shellApi.liveShare (src/preload: liveShare). The sections'
// The pages' own flows: liveShareInvitations.spec.js and liveSharePeople.spec.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
import ThemedSelect from '../components/ui/ThemedSelect.vue'
import { fakeApi, OFF_HOST, OFF_GUEST, invite, guest, sharing } from './liveShareFakes'
import { NO_RIGHTS } from '../../../shared/liveShareRights'
import { setMessages } from '../i18n'
import frLiveShare from '../i18n/locales/fr/liveShare.json'
import { inviteUses } from '../liveShareAccess'

const PROJECTS = { projects: [{ id: 'ws-1', name: 'tessel' }, { id: 'ws-2', name: 'site' }], projectIds: ['ws-1'] }

let api
let push
let offs
beforeEach(() => {
  ;({ api, push, offs } = fakeApi())
  window.shellApi = { liveShare: api, writeClipboard: vi.fn() }
})
afterEach(() => {
  delete window.shellApi
  vi.clearAllMocks()
})

async function open(props = {}) {
  const wrapper = mount(LiveShareDialog, { props: { open: true, ...props }, attachTo: document.body })
  await flushPromises()
  return wrapper
}
async function host(status) {
  push.host({ ...OFF_HOST, ...status })
  await flushPromises()
}
// A menu of the page, by its data-test, and a choice made in it.
const menu = (w, id) => w.findAllComponents(ThemedSelect).find((c) => c.vm.$attrs['data-test'] === id)
async function choose(w, id, value) {
  menu(w, id).vm.$emit('change', { target: { value } })
  await flushPromises()
}
async function guestSays(status) {
  push.guest({ ...OFF_GUEST, ...status })
  await flushPromises()
}

describe('LiveShareDialog: before sharing', () => {
  it('starts with the name, the projects chosen and the first invitation', async () => {
    const wrapper = await open(PROJECTS)
    expect(wrapper.find('[data-test="ls-main"]').exists()).toBe(true)
    // Only the project chosen shows, not every project of the window.
    expect(wrapper.findAll('[data-test^="ls-chip-ws-"]').map((x) => x.text())).toEqual(['tessel'])
    expect(wrapper.find('[data-test="ls-picker"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-share-name"]').element.value).toBe('ada')
    // The first invitation: view only, 1 hour, unless you change it.
    expect(menu(wrapper, 'ls-first-access').props('value')).toBe('view')
    expect(menu(wrapper, 'ls-first-lifetime').props('value')).toBe('hour')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1'], invite: { label: '', lifetime: 'hour', maxUses: 0, rights: { ...NO_RIGHTS, type: false, open: false, close: false } } })
    wrapper.unmount()
  })
  it('the first invitation can be set before starting (what people can do, how long)', async () => {
    const wrapper = await open(PROJECTS)
    await choose(wrapper, 'ls-first-access', 'collaborate')
    await choose(wrapper, 'ls-first-lifetime', 'day')
    expect(wrapper.find('[data-test="ls-first"]').text()).toContain('edit files')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    const sent = api.start.mock.calls[0][0]
    expect(sent.invite.lifetime).toBe('day')
    expect(sent.invite.rights).toMatchObject({ open: true, edit: true, type: false })
    wrapper.unmount()
  })
  it('start, copy, send: once shared, the invitation’s Copy has the keyboard', async () => {
    api.start.mockResolvedValue({ ok: true, ...sharing({ projectIds: ['ws-1'], invites: [invite({ id: 'iv-0000000001', label: '', code: 'TS1.first' })] }) })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    const copy = wrapper.find('[data-test="ls-link-copy"]')
    expect(copy.exists()).toBe(true)
    expect(document.activeElement).toBe(copy.element)
    await copy.trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('TS1.first')
    expect(copy.text()).toBe('Copied')
    wrapper.unmount()
  })
  it('shares the projects you tick, and needs one', async () => {
    const wrapper = await open(PROJECTS)
    // The others are in the picker (Add a project), with a search.
    await wrapper.find('[data-test="ls-add-project"]').trigger('click')
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').element.checked).toBe(true)
    expect(box('ws-2').element.checked).toBe(false)
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
    await wrapper.find('[data-test="ls-picker-search"]').setValue('tes')
    expect(wrapper.findAll('[data-test="ls-picker"] .lpk-row').map((x) => x.text())).toEqual(['tessel'])
    await wrapper.find('[data-test="ls-picker-search"]').setValue('zzz')
    expect(wrapper.find('[data-test="ls-picker-empty"]').text()).toBe('No project matches “zzz”.')
    await wrapper.find('[data-test="ls-picker-done"]').trigger('click')
    expect(wrapper.find('[data-test="ls-picker"]').exists()).toBe(false)
    // A chip's cross takes its project out.
    await wrapper.find('[data-test="ls-chip-remove-ws-1"]').trigger('click')
    expect(wrapper.emitted('toggle-project')[1]).toEqual(['ws-1', false])
    wrapper.unmount()
    const none = await open({ projects: PROJECTS.projects, projectIds: [] })
    expect(none.find('[data-test="ls-start"]').attributes('disabled')).toBeDefined()
    expect(none.find('[data-test="ls-need-project"]').text()).toBe('Tick at least one project.')
    none.unmount()
  })

  it('says how far it got, and Cancel stops', async () => {
    const wrapper = await open()
    await host({ state: 'preparing', progress: 0.424 })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Downloading the Cloudflare tunnel… 42%')
    await host({ state: 'checking' })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Checking the address…')
    await wrapper.find('[data-test="ls-cancel-share"]').trigger('click')
    expect(api.stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('a share starting again by itself after a restart: says why it waits, and its button is Stop sharing', async () => {
    const wrapper = await open()
    await host({ state: 'starting', restarting: true, retry: { at: Date.now() + 15000, error: 'No internet.' } })
    expect(wrapper.find('[data-test="ls-progress"]').text()).toBe('Sharing could not start again yet (No internet.). It tries again by itself.')
    const button = wrapper.find('[data-test="ls-cancel-share"]')
    expect(button.text()).toBe('Stop sharing')
    await button.trigger('click')
    expect(api.stop).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('shows why sharing failed', async () => {
    api.start.mockResolvedValue({ ok: false, error: 'No internet.' })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    // Main's words after a sentence in the interface's language.
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('Sharing could not start: No internet.')
    await host({ state: 'error', error: 'The tunnel stopped.' })
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('Sharing stopped: The tunnel stopped.')
    wrapper.unmount()
  })

  it('sends plain data, as Electron copies it (the first invitation is reactive: Start sharing threw "could not be cloned")', async () => {
    // Electron's IPC copies arguments with the structured clone, which refuses Vue's proxies.
    api.start.mockImplementation(async (arg) => {
      structuredClone(arg)
      return { ok: false, error: 'No internet.' }
    })
    const wrapper = await open(PROJECTS)
    await choose(wrapper, 'ls-first-access', 'full')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    expect(api.start).toHaveBeenCalledTimes(1)
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('Sharing could not start: No internet.')
    wrapper.unmount()
  })

  it('a start that throws says why, not only that it failed', async () => {
    api.start.mockRejectedValue(new Error('An object could not be cloned.'))
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-host-error"]').text()).toBe('Sharing could not start: An object could not be cloned.')
    wrapper.unmount()
  })

  it('one page, no section tabs; Settings and Invitations are pages with Back; before sharing, invitations wait for the share', async () => {
    const wrapper = await open(PROJECTS)
    expect(wrapper.find('.ls-section-tab').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-goto-invites"]').exists()).toBe(false)
    // The people block is there before sharing (trusted people would be in it).
    expect(wrapper.find('[data-test="ls-people-block"]').exists()).toBe(true)
    await wrapper.find('[data-test="ls-goto-settings"]').trigger('click')
    expect(wrapper.find('[data-test="ls-hide-ignored"]').classes()).toContain('set-switch')
    expect(wrapper.find('[data-test="ls-main"]').exists()).toBe(false)
    await wrapper.find('[data-test="ls-back"]').trigger('click')
    expect(wrapper.find('[data-test="ls-main"]').exists()).toBe(true)
    wrapper.unmount()
    const invites = await open({ ...PROJECTS, initialSection: 'invites' })
    expect(invites.find('[data-test="ls-section-off"]').text()).toContain('Invitations come with a share')
    invites.unmount()
  })
  it('the picker: groups (this computer, each SSH host), a project without a folder shows terminals only, an SSH project an SSH tag; a first invitation that types says so in red', async () => {
    const wrapper = await open({ projects: [...PROJECTS.projects, { id: 'ws-3', name: 'box', noFiles: true }, { id: 'ws-4', name: 'srv', ssh: true, host: 'box-a', sshPath: '/srv/app' }, { id: 'ws-5', name: 'home', ssh: true, host: 'box-b', sshPath: '/home/me' }], projectIds: ['ws-1'] })
    await wrapper.find('[data-test="ls-add-project"]').trigger('click')
    expect(wrapper.find('[data-test="ls-project-ws-1"]').classes()).toContain('on')
    expect(wrapper.findAll('.lpk-group').map((x) => x.text())).toEqual(['On this computer 3', 'SSH · box-a 1', 'SSH · box-b 1'])
    expect(wrapper.find('[data-test="ls-nofiles-ws-3"]').text()).toBe('Terminals only')
    // An SSH project's files are shared (guests can read them on the server): a warning-style tag that says so.
    expect(wrapper.find('[data-test="ls-ssh-ws-4"]').text()).toBe('SSH')
    expect(wrapper.find('[data-test="ls-ssh-ws-4"]').classes()).toContain('tag-warn')
    expect(wrapper.find('[data-test="ls-ssh-ws-4"]').attributes('title')).toMatch(/Guests can read this project’s files on the server/)
    // A root too broad shares no files, and the dialog says so.
    expect(wrapper.find('[data-test="ls-ssh-ws-5"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-ssh-broad-ws-5"]').text()).toBe('SSH, no files')
    expect(wrapper.find('[data-test="ls-ssh-broad-ws-5"]').attributes('title')).toMatch(/too broad/)
    expect(wrapper.find('[data-test="ls-nofiles-ws-4"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-first-hint"]').classes()).not.toContain('ls-danger-text')
    // A first invitation that lets them type: its line turns red and says so.
    await choose(wrapper, 'ls-first-access', 'full')
    expect(wrapper.find('[data-test="ls-first-hint"]').classes()).toContain('ls-danger-text')
    expect(wrapper.find('[data-test="ls-first-hint"]').text()).toContain('run any command on this PC as you')
    expect(menu(wrapper, 'ls-first-access').props('value')).toBe('full')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: while sharing', () => {
  it('projects ticked or not on the spot; the last one stays', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1'] })
    await host(sharing({ projectIds: ['ws-1'] }))
    // The last one: its cross is off (and its box in the picker), and says why.
    expect(wrapper.find('[data-test="ls-chip-remove-ws-1"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="ls-chip-remove-ws-1"]').attributes('title')).toBe('To stop sharing your last project, use Stop sharing.')
    await wrapper.find('[data-test="ls-add-project"]').trigger('click')
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').attributes('disabled')).toBeDefined()
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
    wrapper.unmount()
  })

  it('the invitation: its code, what people who join can do, Copy; the others and its options on the Invitations page', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'] })
    await host(sharing({ invites: [invite({ id: 'iv-bbbbbbbbbb', label: 'Team', state: 'blocked' }), invite()], guests: [guest(), guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })] }))
    // The first invitation that lets people in.
    expect(wrapper.findAll('[data-test="ls-invite"]').map((x) => x.attributes('title'))).toEqual(['TS1.code-a'])
    expect(wrapper.find('[data-test="ls-link-copy"]').attributes('disabled')).toBeUndefined()
    expect(menu(wrapper, 'ls-link-access').props('value')).toBe('view')
    // A change goes to that invitation (the people already in keep theirs).
    await choose(wrapper, 'ls-link-access', 'collaborate')
    expect(api.updateInvite).toHaveBeenLastCalledWith({ id: 'iv-aaaaaaaaaa', patch: { rights: expect.objectContaining({ open: true, edit: true, type: false }) }, applyRemovals: true, applyAdditions: false })
    await choose(wrapper, 'ls-link-lifetime', 'week')
    expect(api.updateInvite).toHaveBeenLastCalledWith({ id: 'iv-aaaaaaaaaa', patch: { lifetime: 'week' }, applyRemovals: false, applyAdditions: false })
    // Full control is asked first: nothing changes until Give full control.
    api.updateInvite.mockClear()
    await choose(wrapper, 'ls-link-access', 'full')
    expect(api.updateInvite).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="ls-link-raise-confirm"]').text()).toContain('can run any command on this PC as you')
    await wrapper.find('[data-test="ls-link-raise-yes"]').trigger('click')
    await flushPromises()
    expect(api.updateInvite).toHaveBeenLastCalledWith({ id: 'iv-aaaaaaaaaa', patch: { rights: expect.objectContaining({ type: true }) }, applyRemovals: true, applyAdditions: false })
    expect(wrapper.find('[data-test="ls-goto-invites"]').text()).toContain('1 more')
    expect(wrapper.find('[data-test="ls-waiting-band"]').text()).toContain('One access request')
    await wrapper.find('[data-test="ls-goto-invites"]').trigger('click')
    expect(wrapper.find('[data-test="ls-invitations"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('an expired invitation is not the one shown, and its code cannot be copied', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ invites: [invite({ code: 'TS1.old', expiresAt: Date.now() - 1000 }), invite({ id: 'iv-bbbbbbbbbb', code: 'TS1.new' })] }))
    expect(wrapper.find('[data-test="ls-invite"]').attributes('title')).toBe('TS1.new')
    await host(sharing({ invites: [invite({ code: 'TS1.old', expiresAt: Date.now() - 1000 })] }))
    expect(wrapper.find('[data-test="ls-link-copy"]').attributes('disabled')).toBeDefined()
    wrapper.unmount()
  })
  it('with no invitation left: an empty state and New invitation', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ invites: [] }))
    expect(wrapper.find('[data-test="ls-no-invites"]').text()).toContain('No invitation left')
    await wrapper.find('[data-test="ls-link-new"]').trigger('click')
    await flushPromises()
    expect(api.createInvite).toHaveBeenCalledWith({ label: '', lifetime: 'hour', maxUses: 0, rights: expect.objectContaining({ type: false, open: false }), projects: ['ws-1', 'ws-2'], later: true })
    wrapper.unmount()
  })
  it('the page: its blocks, the code shortened with Copy code and Copy message, one Stop sharing at a time', async () => {
    const long = 'TS2.' + 'a'.repeat(80) + '.tail1234'
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest()], invites: [invite({ code: long }), invite({ id: 'iv-bbbbbbbbbb', label: 'Design review', expiresAt: null })], actions: [{ id: 'a1', at: Date.now(), kind: 'save', name: 'Bob', path: 'a.txt', project: 'ws-1' }] }))
    const titles = wrapper.findAll('[data-test="ls-main"] .ls-block-title').map((x) => x.text().replace(/\s*\d+$/, ''))
    expect(titles).toEqual(['Projects you share', 'People with access', 'Invitation', 'Recent guest actions'])
    const code = wrapper.find('[data-test="ls-invite"]')
    expect(code.text()).toBe('TS2.aaaaaaaaaa…tail1234')
    expect(code.attributes('title')).toBe(long)
    await wrapper.find('[data-test="ls-link-message"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('paste this code: ' + long))
    // Who is in, with their access menu.
    expect(wrapper.find('[data-test="ls-guest-g1"]').text()).toContain('Bob')
    expect(menu(wrapper, 'ls-person-access-g1').props('value')).toBe('view')
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(wrapper.find('[data-test="ls-stop-confirm"]').exists()).toBe(true)
    expect(wrapper.findAll('button').filter((b) => b.text() === 'Stop sharing')).toHaveLength(1)
    // The footer: Done (never Start sharing); Settings is the gear in the header.
    expect(wrapper.find('[data-test="ls-start"]').exists()).toBe(false)
    expect(wrapper.findAll('.confirm-actions > button').map((b) => b.text())).toEqual(['Done'])
    expect(wrapper.find('.help-head [data-test="ls-goto-settings"]').exists()).toBe(true)
    wrapper.unmount()
  })
  it('French: plural uses, the people let in, and times as French writes them', async () => {
    setMessages('fr', frLiveShare)
    try {
      expect(inviteUses({ uses: 1, maxUses: 3 })).toBe('1 utilisation sur 3')
      expect(inviteUses({ uses: 2, maxUses: 3 })).toBe('2 utilisations sur 3')
      const at = new Date(2026, 9, 16, 6, 13).getTime()
      const wrapper = await open(PROJECTS)
      await host(sharing({ invites: [invite({ joined: 2 })], actions: [{ id: 'a1', at, kind: 'save', name: 'Chen', path: 'a.txt', project: 'ws-1' }] }))
      expect(wrapper.find('[data-test="ls-recent-a1"] .ls-recent-time').text()).toBe('06 h 13')
      await wrapper.find('[data-test="ls-goto-invites"]').trigger('click')
      expect(wrapper.find('[data-test="ls-invite-summary"]').text()).toContain('2 personnes entrées')
      await wrapper.find('[data-test="ls-invite-toggle-iv-aaaaaaaaaa"]').trigger('click')
      expect(wrapper.text()).toContain('2 personnes entrées avec elle')
      wrapper.unmount()
    } finally {
      setMessages('en', {})
    }
  })

  it('Stop sharing asks first while someone is in, and not otherwise', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest()] }))
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(api.stop).not.toHaveBeenCalled()
    expect(wrapper.find('[data-test="ls-stop-confirm"]').text()).toContain('1 person is disconnected')
    expect(document.activeElement).toBe(wrapper.find('[data-test="ls-stop-cancel"]').element)
    await wrapper.find('[data-test="ls-stop-confirm"]').trigger('keydown', { key: 'Escape' })
    expect(wrapper.find('[data-test="ls-stop-confirm"]').exists()).toBe(false)
    expect(wrapper.emitted('close')).toBeUndefined()
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    await wrapper.find('[data-test="ls-stop-yes"]').trigger('click')
    expect(api.stop).toHaveBeenCalledTimes(1)
    await host(sharing({ guests: [] }))
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(api.stop).toHaveBeenCalledTimes(2)
    wrapper.unmount()
  })

  it('opens on the page asked for; a project’s Who has access… shows who sees it', async () => {
    api.state.mockResolvedValue({ host: sharing({ guests: [guest(), guest({ id: 'g3', name: 'Tess', projects: ['ws-2'] })] }), guest: OFF_GUEST, defaultName: 'ada' })
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'], initialSection: 'access', focusProject: 'ws-2' })
    expect(wrapper.find('[data-test="ls-main"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ls-people-only"]').text()).toContain('Who sees site')
    expect(wrapper.find('[data-test="ls-guest-g1"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-guest-g3"]').exists()).toBe(true)
    wrapper.unmount()
    const settings = await open({ ...PROJECTS, initialSection: 'settings' })
    expect(settings.find('[data-test="ls-hide-ignored"]').exists()).toBe(true)
    settings.unmount()
  })

})

describe('LiveShareDialog: status and waiting guests', () => {
  it('a status header while sharing: how many projects, the facts, and Stop sharing there', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'] })
    await host(sharing({ settings: { hideIgnored: true, rendezvous: false }, resumed: Date.now() }))
    const status = wrapper.find('[data-test="ls-status"]')
    expect(status.find('[data-test="ls-status-title"]').text()).toBe('Sharing 2 projects')
    expect(status.find('[data-test="ls-status-permanent"]').text()).toBe('Comes back after restarts')
    expect(status.find('[data-test="ls-status-relay"]').text()).toBe('Relay off')
    // Only what is unusual is a tag: the relay off (above), secret files visible.
    expect(status.find('[data-test="ls-status-visible"]').exists()).toBe(false)
    expect(status.find('[data-test="ls-status-resumed"]').exists()).toBe(true)
    expect(status.find('[data-test="ls-stop"]').exists()).toBe(true)
    // On every page.
    await wrapper.find('[data-test="ls-goto-settings"]').trigger('click')
    expect(wrapper.find('[data-test="ls-status"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ls-relay-status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('since when (main’s first start) and when the relay last had the address', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'], initialSection: 'settings' })
    const since = new Date(2026, 9, 19, 14, 2).getTime()
    await host(sharing({ settings: { hideIgnored: true, rendezvous: true }, since, relayAt: Date.now() - 2 * 60000 }))
    expect(wrapper.find('[data-test="ls-status-title"]').text()).toMatch(/^Sharing 2 projects since (14:02|02:02)/)
    expect(wrapper.find('[data-test="ls-status-relay"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-relay-status"]').text()).toBe('Your address was last published 2 minutes ago.')
    await host(sharing({ settings: { hideIgnored: true, rendezvous: true }, since, relayAt: null }))
    expect(wrapper.find('[data-test="ls-relay-status"]').text()).toBe('Your address is not published yet.')
    wrapper.unmount()
  })

  it('since when, when main says', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ projectIds: ['ws-1'], since: new Date(2026, 9, 16, 14, 2).getTime() }))
    expect(wrapper.find('[data-test="ls-status-title"]').text()).toMatch(/^Sharing 1 project since (0?2:02\sPM|14:02)$/)
    wrapper.unmount()
  })

  it('who waits for your answer comes first: Let in brings up their prompt, Refuse turns them away', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })] }))
    const row = wrapper.find('[data-test="ls-waiting-g2"]')
    expect(row.text()).toContain('Eve')
    expect(row.text()).toContain('Code 123 456')
    await wrapper.find('[data-test="ls-waiting-letin-g2"]').trigger('click')
    expect(wrapper.emitted('review-guest')).toEqual([['g2']])
    await wrapper.find('[data-test="ls-waiting-refuse-g2"]').trigger('click')
    await flushPromises()
    expect(api.approve).toHaveBeenCalledWith(expect.objectContaining({ guestId: 'g2', yes: false }))
    expect(wrapper.find('[data-test="ls-host-notice"]').text()).toBe('Eve was turned away.')
    wrapper.unmount()
  })
  it('Stop sharing with only someone waiting says they will be turned away (the toolbar’s words)', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest({ id: 'g2', name: 'Eve', state: 'waiting' })] }))
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(wrapper.find('[data-test="ls-stop-confirm"]').text()).toContain('1 waiting for your answer will be turned away')
    wrapper.unmount()
  })

  it('recent guest actions: the last five, and See all', async () => {
    const actions = Array.from({ length: 7 }, (_, i) => ({ id: 'a' + i, at: Date.now(), kind: 'save', name: 'Chen', path: 'f' + i + '.txt', project: 'ws-1' }))
    const wrapper = await open(PROJECTS)
    await host(sharing({ actions }))
    expect(wrapper.find('[data-test="ls-recent"]').text()).toContain('7')
    expect(wrapper.findAll('.ls-recent-item')).toHaveLength(5)
    await wrapper.find('[data-test="ls-recent-all"]').trigger('click')
    expect(wrapper.findAll('.ls-recent-item')).toHaveLength(7)
    wrapper.unmount()
  })

  it('getting ready: the status says how far, with Cancel there, and the page says when the code comes', async () => {
    const wrapper = await open(PROJECTS)
    await host({ state: 'starting' })
    expect(wrapper.find('[data-test="ls-status"] [data-test="ls-progress"]').text()).toBe('Starting…')
    expect(wrapper.find('[data-test="ls-status"] [data-test="ls-cancel-share"]').text()).toBe('Cancel')
    expect(wrapper.find('[data-test="ls-preparing-note"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ls-start"]').exists()).toBe(false)
    wrapper.unmount()
  })
})

describe('LiveShareDialog: Join', () => {
  it('joins with the code and the name, and follows the session', async () => {
    const wrapper = await open({ initialTab: 'join' })
    expect(wrapper.find('[data-test="ls-join"]').attributes('disabled')).toBeDefined()
    await wrapper.find('[data-test="ls-join-invite"]').setValue('  tessel-ls:xyz  ')
    await wrapper.find('[data-test="ls-join-name"]').setValue('Bob')
    await wrapper.find('[data-test="ls-join"]').trigger('click')
    expect(api.join).toHaveBeenCalledWith({ invite: 'tessel-ls:xyz', name: 'Bob' })
    await guestSays({ state: 'waiting', code: '123 456' })
    expect(wrapper.find('[data-test="ls-guest-state"]').text()).toBe('Waiting for an answer')
    expect(wrapper.find('[data-test="ls-code"]').text()).toContain('123 456')
    expect(wrapper.find('[data-test="ls-code"]').text()).toContain('Tell your host this code')
    await guestSays({ state: 'joined', host: 'Ada', rights: { ...NO_RIGHTS, type: false, open: false, close: false } })
    expect(wrapper.find('[data-test="ls-guest-host"]').text()).toBe('Ada')
    expect(wrapper.find('[data-test="ls-guest-state"]').text()).toBe('Connected')
    expect(wrapper.find('[data-test="ls-no-projects"]').text()).toBe('Ada has not given you a project to see yet.')
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch. The host has not let you type yet.')
    await guestSays({ state: 'joined', host: 'Ada', projects: [{ id: 'ws-a', layout: null }], rights: { ...NO_RIGHTS, type: true, open: true, close: false } })
    expect(wrapper.find('[data-test="ls-rights"]').text()).toBe('You can watch and type in its terminals and agents, open terminals and agents.')
    // The rights grid, read only.
    expect(wrapper.find('[data-test="ls-right-type-guest"] input').element.checked).toBe(true)
    expect(wrapper.find('[data-test="ls-right-type-guest"] input').element.disabled).toBe(true)
    // Reconnecting: the tries, then the relay.
    await guestSays({ state: 'reconnecting', host: 'Ada', retry: { tries: 1, since: 1, lookup: false } })
    expect(wrapper.find('[data-test="ls-reconnect-tries"]').text()).toBe('1 try so far')
    expect(wrapper.find('[data-test="ls-reconnect-lookup"]').exists()).toBe(false)
    await guestSays({ state: 'reconnecting', host: 'Ada', retry: { tries: 3, since: 1, lookup: true } })
    expect(wrapper.find('[data-test="ls-reconnect-tries"]').text()).toBe('3 tries so far')
    expect(wrapper.find('[data-test="ls-reconnect-lookup"]').text()).toContain('ntfy.sh')
    await wrapper.find('[data-test="ls-leave"]').trigger('click')
    expect(api.leave).toHaveBeenCalled()
    wrapper.unmount()
  })

  it('the host’s projects here: a click goes there; Follow host where you picked your own view', async () => {
    const guestProjects = [
      { id: 'w-1', name: 'payments', here: true, follow: { on: true, copy: null } },
      { id: 'w-2', name: 'dashboard', here: false, follow: { on: false, copy: null } }
    ]
    const wrapper = await open({ initialTab: 'join', guestProjects })
    await guestSays({ state: 'joined', host: 'Ada', projects: [{ id: 'p1', layout: null }], rights: { ...NO_RIGHTS } })
    expect(wrapper.find('[data-test="ls-guest-project-w-1"] [data-test="ls-guest-following"]').text()).toBe('Follows Ada')
    expect(wrapper.find('[data-test="ls-guest-project-w-2"] [data-test="ls-guest-own-view"]').exists()).toBe(true)
    await wrapper.find('[data-test="ls-guest-follow-w-2"]').trigger('click')
    expect(wrapper.emitted('follow')).toEqual([['w-2']])
    await wrapper.find('[data-test="ls-guest-project-w-2"] button').trigger('click')
    expect(wrapper.emitted('goto')).toEqual([['w-2']])
    wrapper.unmount()
  })

  it('says why the session ended (a reason the host made up shows as ended)', async () => {
    const wrapper = await open({ initialTab: 'join' })
    await guestSays({ state: 'ended', host: 'Ada', reason: 'denied' })
    expect(wrapper.find('[data-test="ls-ended-why"]').text()).toBe('The host said no.')
    expect(wrapper.find('[data-test="ls-ended"]').text()).toContain('Your session with Ada ended')
    // Too many waiting, or a pause after several noes: said plainly.
    await guestSays({ state: 'ended', host: 'Ada', reason: 'busy' })
    expect(wrapper.find('[data-test="ls-ended-why"]').text()).toContain('The host is not taking new guests right now')
    for (const reason of ['__proto__', 'constructor', 'made-up']) {
      await guestSays({ state: 'ended', host: 'Ada', reason })
      expect(wrapper.find('[data-test="ls-ended-why"]').text()).toBe('The session ended.')
    }
    wrapper.unmount()
  })

  it('Paste a new code: the clipboard’s code in the field (anything else: an empty field)', async () => {
    const wrapper = await open({ initialTab: 'join' })
    await wrapper.find('[data-test="ls-join-invite"]').setValue('TS2.old.code')
    await guestSays({ state: 'ended', host: 'Ada', reason: 'old-code' })
    window.shellApi.readClipboard = vi.fn().mockResolvedValue('  TS2.bmV3.c2VjcmV0  ')
    await wrapper.find('[data-test="ls-paste-new"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-ended"]').exists()).toBe(false)
    expect(wrapper.find('[data-test="ls-join-invite"]').element.value).toBe('TS2.bmV3.c2VjcmV0')
    await guestSays({ state: 'ended', host: 'Ada', reason: 'old-code' })
    window.shellApi.readClipboard = vi.fn().mockResolvedValue('hello there')
    await wrapper.find('[data-test="ls-paste-new"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-join-invite"]').element.value).toBe('')
    delete window.shellApi.readClipboard
    wrapper.unmount()
  })

  it('shows a code that is not an invite', async () => {
    api.join.mockResolvedValue({ ok: false, error: 'This is not a Tessel Live Share invite code.' })
    const wrapper = await open({ initialTab: 'join' })
    await wrapper.find('[data-test="ls-join-invite"]').setValue('hello')
    await wrapper.find('[data-test="ls-join"]').trigger('click')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-join-error"]').text()).toBe('This is not a Tessel Live Share invite code.')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: keyboard and lifetime', () => {
  it('Escape and the backdrop close it; closing does not stop sharing', async () => {
    const wrapper = await open()
    await wrapper.find('[data-test="live-share-dialog"]').trigger('keydown', { key: 'Escape' })
    await wrapper.find('.help-backdrop').trigger('pointerdown')
    expect(wrapper.emitted('close')).toHaveLength(2)
    expect(api.stop).not.toHaveBeenCalled()
    wrapper.unmount()
  })

  it('opens on its card and stops listening once gone', async () => {
    const wrapper = await open()
    expect(document.activeElement).toBe(wrapper.find('[data-test="live-share-dialog"]').element)
    wrapper.unmount()
    expect(offs).toHaveLength(2)
    for (const off of offs) expect(off).toHaveBeenCalled()
  })

  it('says so when this version has no Live Share', async () => {
    window.shellApi = {}
    const wrapper = await open()
    expect(wrapper.text()).toContain('Live Share is not available in this version.')
    wrapper.unmount()
  })
})
