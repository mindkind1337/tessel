// Live Share's dialog (LiveShareDialog.vue): Share (the setup with the first
// invitation, the overview while sharing, its sections) and Join, against a
// fake window.shellApi.liveShare (src/preload: liveShare). The sections'
// own flows: liveShareInvitations.spec.js and liveSharePeople.spec.js.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareDialog from '../components/LiveShareDialog.vue'
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
async function guestSays(status) {
  push.guest({ ...OFF_GUEST, ...status })
  await flushPromises()
}

describe('LiveShareDialog: before sharing', () => {
  it('warns, then starts with the name, the projects and the first invitation', async () => {
    const wrapper = await open(PROJECTS)
    expect(wrapper.find('[data-test="ls-overview"]').exists()).toBe(true)
    expect(wrapper.text()).toContain('run any command on this PC as you')
    expect(wrapper.find('[data-test="ls-share-name"]').element.value).toBe('ada')
    // The first invitation: 1 hour, view only, unless you change it.
    expect(wrapper.find('[data-test="ls-first-summary"]').text()).toContain('View only')
    expect(wrapper.find('[data-test="ls-first-summary"]').text()).toContain('1 hour')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1'], invite: { label: '', lifetime: 'hour', maxUses: 0, rights: { ...NO_RIGHTS, type: false, open: false, close: false } } })
    wrapper.unmount()
  })

  it('the first invitation can be set before starting (label, lifetime, uses, rights)', async () => {
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-first-toggle"]').trigger('click')
    expect(wrapper.find('[data-test="ls-first-toggle"]').attributes('aria-expanded')).toBe('true')
    // No projects there: the first invitation offers every shared project.
    expect(wrapper.find('[data-test="ls-invite-later"]').exists()).toBe(false)
    await wrapper.find('[data-test="ls-invite-label"]').setValue('Team')
    await wrapper.find('[data-test="ls-invite-lifetime-day"] input').setValue(true)
    await wrapper.find('[data-test="ls-invite-uses"]').setValue('3')
    // The rights as presets, or tile by tile.
    await wrapper.find('[data-test="ls-invite-customize"]').trigger('click')
    const openBox = wrapper.find('[data-test="ls-right-open-invite"] input')
    openBox.element.checked = true
    await openBox.trigger('change')
    await flushPromises()
    // Its summary names the preset, not every right.
    expect(wrapper.find('[data-test="ls-first-summary"]').text()).toContain('1 day')
    expect(wrapper.find('[data-test="ls-first-summary"]').text()).toContain('Custom · 1')
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    expect(api.start).toHaveBeenCalledWith({ name: 'ada', projects: ['ws-1'], invite: { label: 'Team', lifetime: 'day', maxUses: 3, rights: { ...NO_RIGHTS, type: false, open: true, close: false } } })
    wrapper.unmount()
  })

  it('start, copy, send: once shared, the first invitation’s Copy has the keyboard', async () => {
    api.start.mockResolvedValue({ ok: true, ...sharing({ projectIds: ['ws-1'], invites: [invite({ id: 'iv-0000000001', label: '', code: 'TS1.first' })] }) })
    const wrapper = await open(PROJECTS)
    await wrapper.find('[data-test="ls-start"]').trigger('click')
    await flushPromises()
    const copy = wrapper.find('[data-test="ls-first-copy-iv-0000000001"]')
    expect(copy.exists()).toBe(true)
    expect(document.activeElement).toBe(copy.element)
    expect(wrapper.find('[data-test="ls-first-iv-0000000001"]').text()).toContain('Invitation')
    await copy.trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith('TS1.first')
    expect(copy.text()).toBe('Copied')
    wrapper.unmount()
  })

  it('shares the projects you tick, and needs one', async () => {
    const wrapper = await open(PROJECTS)
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').element.checked).toBe(true)
    expect(box('ws-2').element.checked).toBe(false)
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
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
    await wrapper.find('[data-test="ls-first-toggle"]').trigger('click')
    await flushPromises()
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

  it('four sections; invitations and people need a share (an empty state says so); trusted people and settings do not', async () => {
    const wrapper = await open(PROJECTS)
    expect(wrapper.findAll('.ls-section-tab').map((x) => x.text())).toEqual(['Overview', 'People', 'Invitations', 'Settings'])
    await wrapper.find('[data-test="ls-section-invites"]').trigger('click')
    expect(wrapper.find('[data-test="ls-section-off"]').text()).toContain('Invitations come with a share')
    await wrapper.find('[data-test="ls-section-people"]').trigger('click')
    expect(wrapper.find('[data-test="ls-section-off"]').exists()).toBe(true)
    // People's grid needs a share; its list shows the trusted people.
    await wrapper.find('[data-test="ls-people-view-grid"]').trigger('click')
    expect(wrapper.find('[data-test="ls-access-off"]').exists()).toBe(true)
    await wrapper.find('[data-test="ls-people-view-list"]').trigger('click')
    await wrapper.find('[data-test="ls-people-filter-trusted"]').trigger('click')
    expect(wrapper.find('[data-test="ls-people-filter-trusted"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="ls-trusted-empty"]').exists()).toBe(true)
    await wrapper.find('[data-test="ls-section-settings"]').trigger('click')
    expect(wrapper.find('[data-test="ls-hide-ignored"]').classes()).toContain('set-switch')
    wrapper.unmount()
  })

  it('the setup card: project chips (a project without a folder shows terminals only; an SSH project shows an SSH tag), the warning as a callout, the facts and a way to Settings', async () => {
    const wrapper = await open({ projects: [...PROJECTS.projects, { id: 'ws-3', name: 'box', noFiles: true }, { id: 'ws-4', name: 'srv', ssh: true, sshPath: '/srv/app' }, { id: 'ws-5', name: 'home', ssh: true, sshPath: '/home/me' }], projectIds: ['ws-1'] })
    expect(wrapper.find('[data-test="ls-project-ws-1"]').classes()).toContain('on')
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
    expect(wrapper.find('[data-test="ls-type-warning"]').classes()).toContain('warn')
    // A first invitation that lets them type: the warning turns red.
    await wrapper.find('[data-test="ls-first-toggle"]').trigger('click')
    await wrapper.find('[data-test="ls-invite-preset-full"] input').trigger('change')
    await flushPromises()
    expect(wrapper.find('[data-test="ls-type-warning"]').classes()).toContain('danger')
    expect(wrapper.find('[data-test="ls-first-summary"]').text()).toContain('Full control')
    expect(wrapper.find('[data-test="ls-facts"]').text()).toContain('Comes back after restarts')
    expect(wrapper.find('[data-test="ls-facts"]').text()).toContain('ntfy.sh: on')
    await wrapper.find('[data-test="ls-goto-settings"]').trigger('click')
    expect(wrapper.find('[data-test="ls-section-settings"]').attributes('aria-selected')).toBe('true')
    wrapper.unmount()
  })
})

describe('LiveShareDialog: while sharing', () => {
  it('projects ticked or not on the spot; the last one stays', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1'] })
    await host(sharing({ projectIds: ['ws-1'] }))
    const box = (id) => wrapper.find(`[data-test="ls-project-${id}"] input`)
    expect(box('ws-1').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="ls-last-project"]').text()).toBe('To stop sharing your last project, use Stop sharing.')
    box('ws-2').element.checked = true
    await box('ws-2').trigger('change')
    expect(wrapper.emitted('toggle-project')).toEqual([['ws-2', true]])
    wrapper.unmount()
  })

  it('the overview lists the codes to copy and who is there, with a way to each section', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'] })
    await host(sharing({ invites: [invite(), invite({ id: 'iv-bbbbbbbbbb', label: 'Team', state: 'blocked' })], guests: [guest(), guest({ id: 'g2', name: 'Eve', state: 'waiting', code: '123 456' })] }))
    expect(wrapper.findAll('[data-test="ls-invite"]').map((x) => x.attributes('title'))).toEqual(['TS1.code-a', 'TS1.code-a'])
    // A blocked code can't be copied from here.
    expect(wrapper.find('[data-test="ls-first-copy-iv-bbbbbbbbbb"]').attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-test="ls-people-summary"]').text()).toContain('1 connected · 1 waiting for your answer')
    expect(wrapper.find('[data-test="ls-section-invites"]').text()).toContain('2')
    expect(wrapper.find('[data-test="ls-section-people"]').text()).toContain('2')
    expect(wrapper.text()).toContain('Codes stop working when you stop sharing')
    await wrapper.find('[data-test="ls-goto-invites"]').trigger('click')
    expect(wrapper.find('[data-test="ls-invitations"]').exists()).toBe(true)
    wrapper.unmount()
  })

  it('with no invitation left: an empty state and a way to make one', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing({ invites: [] }))
    expect(wrapper.find('[data-test="ls-no-invites"]').text()).toContain('No invitation left')
    wrapper.unmount()
  })

  it('the overview: real group labels, each code shortened with Copy code and Copy message, one Stop sharing at a time', async () => {
    const long = 'TS2.' + 'a'.repeat(80) + '.tail1234'
    const wrapper = await open(PROJECTS)
    await host(sharing({ guests: [guest()], invites: [invite({ code: long }), invite({ id: 'iv-bbbbbbbbbb', label: 'Design review', expiresAt: null })] }))
    const labels = wrapper.findAll('[data-test="ls-overview"] .ls-label').map((x) => x.text())
    expect(labels).toEqual(['Projects you share', 'Invitation codes', 'In now', 'Recent guest actions'])
    const code = wrapper.find('[data-test="ls-first-iv-aaaaaaaaaa"] [data-test="ls-invite"]')
    expect(code.text()).toBe('TS2.aaaaaaaaaa…tail1234')
    expect(code.attributes('title')).toBe(long)
    await wrapper.find('[data-test="ls-first-message-iv-aaaaaaaaaa"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.writeClipboard).toHaveBeenCalledWith(expect.stringContaining('paste this code: ' + long))
    // Who is in, with their rights in one chip.
    expect(wrapper.find('[data-test="ls-in-g1"]').text()).toContain('Bob')
    expect(wrapper.find('[data-test="ls-in-g1"] [data-test="ls-rights-chip"]').text()).toBe('View only')
    await wrapper.find('[data-test="ls-stop"]').trigger('click')
    expect(wrapper.find('[data-test="ls-stop-confirm"]').exists()).toBe(true)
    expect(wrapper.findAll('button').filter((b) => b.text() === 'Stop sharing')).toHaveLength(1)
    // The footer keeps only Close meanwhile (never Start sharing).
    expect(wrapper.find('[data-test="ls-start"]').exists()).toBe(false)
    expect(wrapper.findAll('.confirm-actions > button').map((b) => b.text())).toEqual(['Close'])
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
      await wrapper.find('[data-test="ls-section-invites"]').trigger('click')
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

  it('opens on the section asked for (a project’s Who has access…)', async () => {
    api.state.mockResolvedValue({ host: sharing({ guests: [guest()] }), guest: OFF_GUEST, defaultName: 'ada' })
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'], initialSection: 'access', focusProject: 'ws-2' })
    // Access is People's grid now, the project's column lit.
    expect(wrapper.find('[data-test="ls-section-people"]').attributes('aria-selected')).toBe('true')
    expect(wrapper.find('[data-test="ls-people-view-grid"]').attributes('aria-pressed')).toBe('true')
    expect(wrapper.find('[data-test="ls-access-col-ws-2"]').classes()).toContain('focus')
    expect(wrapper.find('[data-test="ls-access-focus"]').text()).toContain('Who has access to site')
    wrapper.unmount()
  })

  it('arrow keys move between the sections', async () => {
    const wrapper = await open(PROJECTS)
    await host(sharing())
    const tabs = wrapper.find('.ls-sections')
    await tabs.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.find('[data-test="ls-section-people"]').attributes('aria-selected')).toBe('true')
    await tabs.trigger('keydown', { key: 'End' })
    expect(wrapper.find('[data-test="ls-section-settings"]').attributes('aria-selected')).toBe('true')
    await tabs.trigger('keydown', { key: 'ArrowRight' })
    expect(wrapper.find('[data-test="ls-section-overview"]').attributes('aria-selected')).toBe('true')
    wrapper.unmount()
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
    expect(status.find('[data-test="ls-status-hidden"]').exists()).toBe(true)
    expect(status.find('[data-test="ls-status-resumed"]').exists()).toBe(true)
    expect(status.find('[data-test="ls-stop"]').exists()).toBe(true)
    // On every section.
    await wrapper.find('[data-test="ls-section-settings"]').trigger('click')
    expect(wrapper.find('[data-test="ls-status"]').exists()).toBe(true)
    expect(wrapper.find('[data-test="ls-relay-status"]').exists()).toBe(false)
    wrapper.unmount()
  })

  it('since when (main’s first start) and when the relay last had the address', async () => {
    const wrapper = await open({ ...PROJECTS, projectIds: ['ws-1', 'ws-2'], initialSection: 'settings' })
    const since = new Date(2026, 9, 19, 14, 2).getTime()
    await host(sharing({ settings: { hideIgnored: true, rendezvous: true }, since, relayAt: Date.now() - 2 * 60000 }))
    expect(wrapper.find('[data-test="ls-status-title"]').text()).toMatch(/^Sharing 2 projects since (14:02|02:02)/)
    expect(wrapper.find('[data-test="ls-status-relay"]').attributes('title')).toBe('Your address was last published 2 minutes ago.')
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
    const row = wrapper.find('[data-test="ls-ov-waiting-g2"]')
    expect(row.text()).toContain('Eve')
    expect(row.text()).toContain('Code 123 456')
    expect(wrapper.find('[data-test="ls-section-people"] .ls-count').classes()).toContain('warn')
    await wrapper.find('[data-test="ls-ov-letin-g2"]').trigger('click')
    expect(wrapper.emitted('review-guest')).toEqual([['g2']])
    await wrapper.find('[data-test="ls-ov-refuse-g2"]').trigger('click')
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
    expect(wrapper.findAll('.ls-recent-item')).toHaveLength(5)
    await wrapper.find('[data-test="ls-recent-all"]').trigger('click')
    expect(wrapper.findAll('.ls-recent-item')).toHaveLength(7)
    wrapper.unmount()
  })

  it('getting ready: the status says how far, with Cancel there, and the overview says when the code comes', async () => {
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
