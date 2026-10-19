// The prompt when someone asks to join, or asks to open or close something
// (LiveShareAsk.vue): the invitation used, its projects and rights ticked
// (one click to let them in), trust only once the code was checked, the yes
// armed after a moment, one answer per ask, and how many more wait.
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'
import { nextTick } from 'vue'
import { mount, flushPromises } from '@vue/test-utils'
import LiveShareAsk from '../components/LiveShareAsk.vue'
import { NO_RIGHTS } from '../../../shared/liveShareRights'

const PROJECTS = [
  { id: 'ws-1', name: 'tessel' },
  { id: 'ws-2', name: 'site' },
  { id: 'ws-3', name: 'api' }
]
const bob = {
  kind: 'join',
  key: 'g1',
  guestId: 'g1',
  name: 'Bob',
  code: '123 456',
  invite: { id: 'iv-aaaaaaaaaa', label: 'Design team' },
  offer: { projects: ['ws-2'], rights: { ...NO_RIGHTS, type: false, open: true, close: false } },
  trustable: true
}

beforeEach(() => vi.useFakeTimers())
afterEach(() => vi.useRealTimers())
const arm = async () => {
  vi.advanceTimersByTime(1000)
  await nextTick()
}
const boxes = (w, prefix) => w.findAll(`[data-test^="${prefix}"] input`).map((b) => b.element.checked)

describe('LiveShareAsk: someone asks to join', () => {
  it('shows nothing while no one is waiting', () => {
    const w = mount(LiveShareAsk, { props: { ask: null } })
    expect(w.find('[data-test="live-share-ask"]').exists()).toBe(false)
  })

  it('names who asks, the invitation used and the code; takes the keyboard on the card', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS }, attachTo: document.body })
    await flushPromises()
    expect(w.text()).toContain('Bob wants to join your Live Share')
    expect(w.find('[data-test="ls-ask-invite"]').text()).toBe('With the invitation “Design team”')
    expect(w.find('[data-test="ls-ask-code"]').text()).toContain('123 456')
    expect(document.activeElement).toBe(w.find('[data-test="live-share-ask"]').element)
    w.unmount()
  })

  it('prefilled with the invitation’s projects and rights: one click lets them in', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS } })
    await nextTick()
    expect(boxes(w, 'ls-ask-project-')).toEqual([false, true, false])
    // (Every right of the catalog, in its order: type, open, close, then the rest off.)
    expect(boxes(w, 'ls-right-')).toEqual([false, true, false, false, false, false, false, false])
    await arm()
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')).toEqual([[{ key: 'g1', yes: true, projects: ['ws-2'], rights: { ...NO_RIGHTS, type: false, open: true, close: false }, trust: false }]])
  })

  it('the boxes can be changed before allowing', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS } })
    await arm()
    await w.find('[data-test="ls-ask-project-ws-1"] input').trigger('change')
    const type = w.find('[data-test="ls-right-type-ask"] input')
    type.element.checked = true
    await type.trigger('change')
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')[0][0]).toMatchObject({ projects: ['ws-1', 'ws-2'], rights: { ...NO_RIGHTS, type: true, open: true, close: false } })
  })

  it('without an invitation’s offer: every project shared ticked, every right off', async () => {
    const w = mount(LiveShareAsk, { props: { ask: { ...bob, invite: null, offer: null }, projects: PROJECTS } })
    await nextTick()
    expect(w.find('[data-test="ls-ask-invite"]').exists()).toBe(false)
    expect(boxes(w, 'ls-ask-project-')).toEqual([true, true, true])
    expect(boxes(w, 'ls-right-')).toEqual([false, false, false, false, false, false, false, false])
  })

  it('Trust this person: only once the code was checked, and only for a Tessel that can be trusted', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS } })
    expect(w.find('[data-test="ls-ask-trust"]').exists()).toBe(true)
    expect(w.find('[data-test="ls-ask-trust-box"]').exists()).toBe(false)
    await w.find('[data-test="ls-ask-code-checked"] input').setValue(true)
    await w.find('[data-test="ls-ask-trust-box"] input').setValue(true)
    await arm()
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')[0][0].trust).toBe(true)
    // Unticking the code check takes trust back.
    await w.setProps({ ask: { ...bob, key: 'g2', guestId: 'g2' } })
    await w.find('[data-test="ls-ask-code-checked"] input').setValue(true)
    await w.find('[data-test="ls-ask-trust-box"] input').setValue(true)
    await w.find('[data-test="ls-ask-code-checked"] input').setValue(false)
    expect(w.find('[data-test="ls-ask-trust-box"]').exists()).toBe(false)
    await arm()
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')[1][0].trust).toBe(false)
    // An older Tessel (no identity key), or no code: no trust offered.
    await w.setProps({ ask: { ...bob, key: 'g3', guestId: 'g3', trustable: false } })
    expect(w.find('[data-test="ls-ask-trust"]').exists()).toBe(false)
    await w.setProps({ ask: { ...bob, key: 'g4', guestId: 'g4', code: null } })
    expect(w.find('[data-test="ls-ask-trust"]').exists()).toBe(false)
  })

  it('Allow only answers after a moment; Deny answers; Escape or a click beside it do not', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS } })
    await w.find('.help-backdrop').trigger('pointerdown')
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    await w.find('[data-test="live-share-ask"]').trigger('keydown', { key: 'Escape' })
    expect(w.emitted('answer')).toBeUndefined()
    await w.find('[data-test="ls-ask-deny"]').trigger('click')
    expect(w.emitted('answer')).toEqual([[{ key: 'g1', yes: false, projects: ['ws-2'], rights: { ...NO_RIGHTS, type: false, open: true, close: false }, trust: false }]])
  })

  it('none ticked: Allow waits and says why; a project shared while it waits comes unticked and re-arms', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS.slice(0, 2) } })
    await arm()
    await w.find('[data-test="ls-ask-project-ws-2"] input').trigger('change')
    expect(w.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
    expect(w.find('[data-test="ls-ask-need-project"]').text()).toBe('Tick at least one project to allow them in.')
    await w.find('[data-test="ls-ask-project-ws-1"] input').trigger('change')
    await w.setProps({ projects: PROJECTS })
    expect(boxes(w, 'ls-ask-project-')).toEqual([true, false, false])
    expect(w.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
    await arm()
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')[0][0].projects).toEqual(['ws-1'])
  })

  it('no project listed yet (a share taken back after a restart): Allow waits, and says why', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: [] } })
    await arm()
    expect(w.find('[data-test="ls-ask-no-projects"]').exists()).toBe(true)
    expect(w.find('[data-test="ls-ask-allow"]').attributes('disabled')).toBeDefined()
    // They come: ticked as offered.
    await w.setProps({ projects: PROJECTS })
    expect(boxes(w, 'ls-ask-project-')).toEqual([false, true, false])
  })

  it('says how many more wait after this one', async () => {
    const w = mount(LiveShareAsk, { props: { ask: bob, projects: PROJECTS, more: 0 } })
    expect(w.find('[data-test="ls-ask-more"]').exists()).toBe(false)
    await w.setProps({ more: 2 })
    expect(w.find('[data-test="ls-ask-more"]').text()).toBe('2 more waiting after this one')
  })

  it('a guest without a name is "A guest"', () => {
    const w = mount(LiveShareAsk, { props: { ask: { ...bob, name: '' }, projects: PROJECTS } })
    expect(w.text()).toContain('A guest wants to join your Live Share')
  })
})

describe('LiveShareAsk: open and close requests', () => {
  it('a guest without the right asks to open an agent: Don’t open or Open it', async () => {
    const ask = { kind: 'open', key: 'open-g1-1', guestId: 'g1', name: 'Bob', spec: { kind: 'agent', agent: 'claude', project: 'ws-1' }, projectName: 'tessel', agentName: 'Claude Code' }
    const w = mount(LiveShareAsk, { props: { ask } })
    expect(w.text()).toContain('Bob asks to open Claude Code')
    expect(w.find('[data-test="ls-ask-open-text"]').text()).toContain('in tessel')
    expect(w.find('[data-test="ls-ask-deny"]').text()).toBe('Don’t open')
    expect(w.find('[data-test="ls-ask-allow"]').text()).toBe('Open it')
    await arm()
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')).toEqual([[{ key: 'open-g1-1', yes: true }]])
    await w.setProps({ ask: { ...ask, key: 'open-g1-2', agentName: null, spec: { kind: 'terminal', project: 'ws-1' } } })
    expect(w.text()).toContain('Bob asks to open a terminal')
  })

  it('asks before a guest closes an agent or a busy terminal: Keep it or Close it', async () => {
    const ask = { kind: 'close', key: 'close-pane-1', guestId: 'g1', name: 'Bob', paneId: 'pane-1', paneName: 'Claude Code', detail: 'Its agent session ends.' }
    const w = mount(LiveShareAsk, { props: { ask } })
    expect(w.text()).toContain('Bob wants to close Claude Code')
    expect(w.find('[data-test="ls-ask-deny"]').text()).toBe('Keep it')
    await arm()
    await w.find('[data-test="ls-ask-allow"]').trigger('click')
    expect(w.emitted('answer')).toEqual([[{ key: 'close-pane-1', yes: true }]])
  })
})
