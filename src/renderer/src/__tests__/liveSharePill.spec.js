// Live Share's status display: the top-bar pill (LiveSharePill.vue) for the
// host (nobody / someone connected) and the guest, the presence marks on a
// pane (LiveSharePresence.vue, LiveShareReaders.vue), and the guest's "+"
// menu in a host's project (LaunchMenu.vue hostMenu).
import { describe, expect, it, vi } from 'vitest'
import { ref, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import LiveSharePill from '../components/LiveSharePill.vue'
import LiveSharePresence from '../components/LiveSharePresence.vue'
import LiveShareReaders from '../components/LiveShareReaders.vue'
import LaunchMenu from '../components/LaunchMenu.vue'

const hostPill = (over = {}) => ({
  mode: 'host',
  starting: false,
  guests: [],
  waiting: 0,
  projects: [
    { id: 'ws-1', name: 'ESXLegacy', here: true, people: [] },
    { id: 'ws-2', name: 'site', here: false, people: [] }
  ],
  current: { id: 'ws-1', name: 'ESXLegacy', shared: true },
  ...over
})

describe('LiveSharePill: host', () => {
  it('nobody connected: "Live · 0" with a grey dot', () => {
    const w = mount(LiveSharePill, { props: { pill: hostPill() } })
    const pill = w.find('[data-test="live-pill"]')
    expect(pill.text()).toBe('Live · 0')
    expect(w.find('[data-test="live-pill-dot"]').classes()).not.toContain('lit')
    expect(pill.attributes('aria-label')).toContain('0 people connected')
    expect(pill.attributes('aria-expanded')).toBe('false')
  })

  it('someone connected: the dot lights up and the count shows', () => {
    const w = mount(LiveSharePill, { props: { pill: hostPill({ guests: [{ id: 'g1', name: 'Simpa', via: 'Design', watching: [], typing: [] }] }) } })
    expect(w.find('[data-test="live-pill"]').text()).toBe('Live · 1')
    expect(w.find('[data-test="live-pill-dot"]').classes()).toContain('lit')
    expect(w.find('[data-test="live-pill"]').attributes('aria-label')).toContain('1 person connected')
  })

  it('starting: a pulsing grey dot', () => {
    const w = mount(LiveSharePill, { props: { pill: hostPill({ starting: true }) } })
    expect(w.find('[data-test="live-pill"]').text()).toBe('Starting…')
    expect(w.find('[data-test="live-pill-dot"]').classes()).toEqual(expect.arrayContaining(['pulse']))
  })

  it('its popover: the shared projects, who is there and what they watch, and the ways out', async () => {
    const pill = hostPill({
      guests: [
        { id: 'g1', name: 'Simpa', via: 'Design', watching: ['Claude Code'], typing: [] },
        { id: 'g2', name: 'Eve', via: '', watching: ['Shell'], typing: ['Shell'] }
      ],
      waiting: 2,
      projects: [
        { id: 'ws-1', name: 'ESXLegacy', here: true, people: [{ id: 'g1', name: 'Simpa' }] },
        { id: 'ws-2', name: 'site', here: false, people: [] }
      ]
    })
    const w = mount(LiveSharePill, { props: { pill }, attachTo: document.body })
    await w.find('[data-test="live-pill"]').trigger('click')
    const pop = w.find('[data-test="live-pill-popover"]')
    expect(pop.exists()).toBe(true)
    expect(pop.text()).toContain('Sharing: 2 people connected')
    expect(w.find('[data-test="live-pill-project-ws-1"]').text()).toContain('ESXLegacy')
    expect(w.find('[data-test="live-pill-project-ws-1"] [data-test="ls-avatars"]').attributes('title')).toBe('In ESXLegacy: Simpa')
    expect(w.find('[data-test="live-pill-guest-g1"]').text()).toContain('Design')
    expect(w.find('[data-test="live-pill-guest-g1"]').text()).toContain('Watching Claude Code')
    expect(w.find('[data-test="live-pill-guest-g2"]').text()).toContain('Typing in Shell')
    expect(w.find('[data-test="live-pill-waiting"]').text()).toBe('2 people waiting for your answer')
    // The first button has the keyboard.
    expect(pop.element.contains(document.activeElement)).toBe(true)
    await w.find('[data-test="live-pill-project-ws-2"] button').trigger('click')
    expect(w.emitted('goto')).toEqual([['ws-2']])
    expect(w.find('[data-test="live-pill-popover"]').exists()).toBe(false)
    w.unmount()
  })

  it('Share / Stop sharing this project, × on a project, and the dialog sections', async () => {
    const w = mount(LiveSharePill, { props: { pill: hostPill({ current: { id: 'ws-3', name: 'notes', shared: false } }) } })
    const open = async () => w.find('[data-test="live-pill"]').trigger('click')
    await open()
    await w.find('[data-test="live-pill-share-here"]').trigger('click')
    expect(w.emitted('share')).toEqual([['ws-3', true]])
    await w.setProps({ pill: hostPill() })
    await open()
    await w.find('[data-test="live-pill-unshare-here"]').trigger('click')
    expect(w.emitted('share').at(-1)).toEqual(['ws-1', false])
    await open()
    await w.find('[data-test="live-pill-remove-ws-2"]').trigger('click')
    expect(w.emitted('share').at(-1)).toEqual(['ws-2', false])
    await open()
    await w.find('[data-test="live-pill-manage"]').trigger('click')
    expect(w.emitted('open').at(-1)).toEqual(['overview'])
    await open()
    await w.find('[data-test="live-pill-stop"]').trigger('click')
    expect(w.emitted('stop')).toHaveLength(1)
  })

  it('the last project shared has no ×; nobody connected: an empty state', async () => {
    const w = mount(LiveSharePill, { props: { pill: hostPill({ projects: [{ id: 'ws-1', name: 'ESXLegacy', here: true, people: [] }] }) } })
    await w.find('[data-test="live-pill"]').trigger('click')
    expect(w.find('[data-test="live-pill-remove-ws-1"]').exists()).toBe(false)
    expect(w.find('[data-test="live-pill-unshare-here"]').exists()).toBe(false)
    expect(w.find('[data-test="live-pill-nobody"]').text()).toContain('Nobody yet')
  })

  it('people waiting: an amber badge on the pill, and their row with the code and Let in', async () => {
    const pill = hostPill({ guests: [{ id: 'g1', name: 'Simpa', via: '', rights: { type: true }, watching: [], typing: [] }], waiting: 1, waitingList: [{ id: 'g3', name: 'Eve', code: '482 913' }] })
    const w = mount(LiveSharePill, { props: { pill } })
    expect(w.find('[data-test="live-pill"]').text()).toBe('Live · 11')
    expect(w.find('[data-test="live-pill-badge"]').text()).toBe('1')
    expect(w.find('[data-test="live-pill"]').attributes('aria-label')).toContain('1 waiting for your answer')
    await w.find('[data-test="live-pill"]').trigger('click')
    expect(w.find('[data-test="live-pill-wait-g3"]').text()).toContain('Code 482 913')
    // The people in now: their rights in one chip (red: they can type).
    expect(w.find('[data-test="live-pill-guest-g1"] [data-test="ls-rights-chip"]').classes()).toContain('tag-danger')
    await w.find('[data-test="live-pill-letin-g3"]').trigger('click')
    expect(w.emitted('review')).toEqual([['g3']])
    expect(w.find('[data-test="live-pill-popover"]').exists()).toBe(false)
  })

  it('the status header (since, Permanent, Relay on|off) and Copy invite code', async () => {
    const since = new Date(2026, 9, 19, 14, 2).getTime()
    const w = mount(LiveSharePill, { props: { pill: hostPill({ since, relay: false, invite: { id: 'iv-1', label: 'First invite code', code: 'TS2.abc.def' } }) } })
    await w.find('[data-test="live-pill"]').trigger('click')
    expect(w.find('[data-test="live-pill-since"]').text()).toMatch(/^Since 14:02|^Since 02:02/)
    expect(w.find('[data-test="live-pill-permanent"]').text()).toBe('Permanent')
    expect(w.find('[data-test="live-pill-relay"]').text()).toBe('Relay off')
    await w.find('[data-test="live-pill-copy-invite"]').trigger('click')
    expect(w.emitted('copy-invite')).toEqual([[{ id: 'iv-1', label: 'First invite code', code: 'TS2.abc.def' }]])
    expect(w.find('[data-test="live-pill-copy-invite"]').text()).toBe('Copied')
  })

  it('a share starting again: "Restarting…", then "Retrying in 30 s" once it could not yet', async () => {
    vi.useFakeTimers()
    try {
      const w = mount(LiveSharePill, { props: { pill: hostPill({ starting: true, restarting: true }) } })
      expect(w.find('[data-test="live-pill"]').text()).toBe('Restarting…')
      await w.setProps({ pill: hostPill({ starting: true, restarting: true, retryAt: Date.now() + 30000 }) })
      expect(w.find('[data-test="live-pill"]').text()).toBe('Retrying in 30 s')
      vi.advanceTimersByTime(10000)
      await nextTick()
      expect(w.find('[data-test="live-pill"]').text()).toBe('Retrying in 20 s')
      vi.advanceTimersByTime(21000)
      await nextTick()
      expect(w.find('[data-test="live-pill"]').text()).toBe('Restarting…')
      w.unmount()
    } finally {
      vi.useRealTimers()
    }
  })

  it('Escape closes the popover and gives the keyboard back to the pill; a click outside closes it', async () => {
    const w = mount(LiveSharePill, { props: { pill: hostPill() }, attachTo: document.body })
    await w.find('[data-test="live-pill"]').trigger('click')
    await w.find('[data-test="live-pill-popover"]').trigger('keydown', { key: 'Escape' })
    await nextTick()
    expect(w.find('[data-test="live-pill-popover"]').exists()).toBe(false)
    expect(document.activeElement).toBe(w.find('[data-test="live-pill"]').element)
    await w.find('[data-test="live-pill"]').trigger('click')
    document.body.dispatchEvent(new Event('pointerdown', { bubbles: true }))
    await nextTick()
    expect(w.find('[data-test="live-pill-popover"]').exists()).toBe(false)
    w.unmount()
  })
})

describe('LiveSharePill: guest', () => {
  const guestPill = (over = {}) => ({ mode: 'guest', host: 'jeanc', reconnecting: false, rights: 'You can watch. The host has not let you type yet.', code: '123 456', projects: [{ id: 'ws-9', name: 'ESXLegacy — jeanc', here: true }], ...over })

  it('"Live with jeanc"; its popover explains, sums up the rights, shows the code, and Leave', async () => {
    const w = mount(LiveSharePill, { props: { pill: guestPill() } })
    expect(w.find('[data-test="live-pill"]').text()).toBe('Live with jeanc')
    expect(w.find('[data-test="live-pill-dot"]').classes()).toContain('lit')
    await w.find('[data-test="live-pill"]').trigger('click')
    expect(w.find('[data-test="live-pill-guest-text"]').text()).toContain('jeanc’s computer')
    expect(w.find('[data-test="live-pill-rights"]').text()).toBe('You can watch. The host has not let you type yet.')
    expect(w.find('[data-test="live-pill-code"]').text()).toBe('Your verification code: 123 456')
    await w.find('[data-test="live-pill-leave"]').trigger('click')
    expect(w.emitted('leave')).toHaveLength(1)
    await w.find('[data-test="live-pill"]').trigger('click')
    await w.find('[data-test="live-pill-manage"]').trigger('click')
    expect(w.emitted('open')).toEqual([['join']])
  })

  it('reconnecting: says so, with a grey pulsing dot, the tries and the relay', async () => {
    const w = mount(LiveSharePill, { props: { pill: guestPill({ reconnecting: true, retry: { tries: 3, lookup: true } }) } })
    expect(w.find('[data-test="live-pill"]').text()).toBe('Reconnecting to jeanc…')
    expect(w.find('[data-test="live-pill-dot"]').classes()).toContain('pulse')
    await w.find('[data-test="live-pill"]').trigger('click')
    expect(w.find('[data-test="live-pill-reconnect"]').text()).toBe('Try 3 · Looking up the host’s new address via ntfy.sh')
  })

  it('the follow switch: on follows the host again, off stops following; the rights chip', async () => {
    const w = mount(LiveSharePill, { props: { pill: guestPill({ grant: { open: true }, follow: { on: true, copy: null } }) } })
    await w.find('[data-test="live-pill"]').trigger('click')
    expect(w.find('[data-test="live-pill-rights-box"] [data-test="ls-rights-chip"]').exists()).toBe(true)
    const sw = w.find('[data-test="live-pill-follow-switch"] input')
    expect(sw.element.checked).toBe(true)
    sw.element.checked = false
    await sw.trigger('change')
    expect(w.emitted('unfollow')).toHaveLength(1)
    // It shows main's state until the pill says otherwise.
    expect(sw.element.checked).toBe(true)
    await w.setProps({ pill: guestPill({ follow: { on: false, copy: null } }) })
    const off = w.find('[data-test="live-pill-follow-switch"] input')
    off.element.checked = true
    await off.trigger('change')
    expect(w.emitted('follow')).toHaveLength(1)
  })
})

describe('Presence on a pane (host)', () => {
  const mountWith = (Comp, list, props = {}) => {
    const state = ref(list)
    const ctx = { liveSharePresence: vi.fn((id) => (id === 'pane-1' ? state.value : [])), liveShareReaders: (id) => (id === 'pane-1' ? state.value.filter((p) => p.reading).map((p) => p.name) : []) }
    const w = mount(Comp, { props: { paneId: 'pane-1', ...props }, global: { provide: { panelCtx: ctx } } })
    return { w, state }
  }

  it('an eye with initials while watching; three dots while typing; nothing when nobody is there', async () => {
    const { w, state } = mountWith(LiveSharePresence, [{ id: 'g1', name: 'Simpa', initials: 'SI', watching: true, typing: false, reading: false }])
    expect(w.find('[data-test="ls-presence-watching"]').text()).toBe('SI')
    expect(w.find('[data-test="ls-presence-watching"]').attributes('aria-label')).toBe('Watching this pane in Live Share: Simpa')
    expect(w.find('[data-test="ls-presence-typing"]').exists()).toBe(false)
    state.value = [{ id: 'g1', name: 'Simpa', initials: 'SI', watching: true, typing: true, reading: false }]
    await nextTick()
    expect(w.find('[data-test="ls-presence-typing"]').attributes('aria-label')).toBe('Typing here in Live Share: Simpa')
    // Typing says more than watching: one mark per person.
    expect(w.find('[data-test="ls-presence-watching"]').exists()).toBe(false)
    state.value = []
    await nextTick()
    expect(w.find('[data-test="ls-presence"]').exists()).toBe(false)
  })

  it('the header keeps the chat-bubble eye for readers; the sidebar’s compact form shows readers itself', async () => {
    const reading = [{ id: 'g2', name: 'Eve', initials: 'EV', watching: false, typing: false, reading: true }]
    const header = mountWith(LiveSharePresence, reading)
    expect(header.w.find('[data-test="ls-presence"]').exists()).toBe(false)
    const readers = mountWith(LiveShareReaders, reading)
    expect(readers.w.find('[data-test="pane-liveshare-readers"]').text()).toBe('1')
    const row = mountWith(LiveSharePresence, reading, { compact: true })
    expect(row.w.find('[data-test="ls-presence-reading"]').text()).toBe('EV')
  })
})

describe('The guest’s "+" menu in a host’s project', () => {
  const props = (hostMenu) => ({ shells: [{ id: 'pwsh', name: 'PowerShell' }], agents: [{ id: 'gemini', name: 'Gemini', available: true }], hostMenu, accountChoice: false })

  it('with the right to open: the host’s shell and agents, nothing of this computer', async () => {
    const w = mount(LaunchMenu, { props: props({ host: 'jeanc', agents: [{ id: 'claude', name: 'Claude Code' }, { id: 'codex', name: 'Codex' }], canOpen: true }) })
    expect(w.find('[data-test="launch-host-where"]').text()).toBe('Opens on jeanc’s computer, beside their active pane')
    expect(w.find('[data-test="launch-host-terminal"]').text()).toContain('jeanc’s shell')
    expect(w.find('[data-test="launch-host-agent-claude"]').text()).toBe('Claude Code')
    expect(w.find('[data-test="launch-host-agent-codex"]').exists()).toBe(true)
    // This computer's shells, agents, browser and tools are not offered there.
    expect(w.text()).not.toContain('PowerShell')
    expect(w.text()).not.toContain('Gemini')
    expect(w.find('[data-test="launch-browser"]').exists()).toBe(false)
    expect(w.find('[data-test="launch-host-asks"]').exists()).toBe(false)
    await w.find('[data-test="launch-host-agent-claude"]').trigger('click')
    await w.find('[data-test="launch-host-terminal"]').trigger('click')
    expect(w.emitted('launch')).toEqual([[{ kind: 'agent', id: 'claude' }], [{ kind: 'shell', id: 'host' }]])
  })

  it('without it: the same menu, saying the host is asked first; a host with no agents says so', () => {
    const w = mount(LaunchMenu, { props: props({ host: 'jeanc', agents: [], canOpen: false }) })
    expect(w.find('[data-test="launch-host-asks"]').text()).toBe('jeanc is asked first: it opens once they say yes.')
    expect(w.find('[data-test="launch-host-no-agents"]').text()).toBe('jeanc offers no agents.')
  })

  it('no host menu: this computer’s menu as before', () => {
    const w = mount(LaunchMenu, { props: props(null) })
    expect(w.text()).toContain('PowerShell')
    expect(w.find('[data-test="launch-host-terminal"]').exists()).toBe(false)
  })
})
