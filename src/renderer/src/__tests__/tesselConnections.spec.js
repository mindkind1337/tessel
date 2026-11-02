// Settings > Connections, Tessel's own connectors: every service has a row, the server says which can
// be connected, and one that cannot says so before anyone clicks.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import TesselConnections from '../components/settings/TesselConnections.vue'

const ALL = ['google', 'microsoft', 'github', 'dropbox', 'notion', 'linear', 'atlassian', 'sentry', 'vercel', 'stripe']
const blank = { connections: [], connecting: null, error: null, notEnded: [] }

function fake(over = {}) {
  return {
    view: vi.fn(async () => blank),
    services: vi.fn(async () => ({ services: ['google'] })),
    connect: vi.fn(async (service) => ({ ...blank, connecting: service })),
    cancel: vi.fn(async () => blank),
    disconnect: vi.fn(async () => blank),
    onChanged: vi.fn(() => () => {}),
    ...over
  }
}
async function panel(api) {
  window.shellApi = { tesselApps: api }
  const w = mount(TesselConnections)
  await flushPromises()
  return w
}
const row = (w, id) => w.get(`[data-connector="${id}"]`)

describe('Tessel connectors', () => {
  let w
  afterEach(() => {
    if (w) w.unmount()
    w = null
    delete window.shellApi
  })

  it('shows every service', async () => {
    w = await panel(fake())
    expect(w.findAll('[data-connector]').map((r) => r.attributes('data-connector'))).toEqual(ALL)
    expect(row(w, 'atlassian').text()).toContain('Jira, Confluence')
    expect(row(w, 'microsoft').text()).toContain('Outlook mail, Outlook Calendar, OneDrive')
    expect(row(w, 'stripe').text()).toContain('Read only.')
  })

  it('what the server says is not ready says so, and has nothing to press', async () => {
    const api = fake()
    w = await panel(api)
    expect(row(w, 'google').find('[data-test="tcx-connect"]').exists()).toBe(true)
    expect(row(w, 'google').find('[data-test="tcx-not-yet"]').exists()).toBe(false)
    for (const id of ALL.filter((x) => x !== 'google')) {
      expect(row(w, id).find('[data-test="tcx-connect"]').exists(), id).toBe(false)
      expect(row(w, id).get('[data-test="tcx-not-yet"]').text()).toContain('Not available yet')
    }
    await row(w, 'google').get('[data-test="tcx-connect"]').trigger('click')
    expect(api.connect).toHaveBeenCalledWith('google')
  })

  it('a service that became ready can be connected', async () => {
    const api = fake({ services: vi.fn(async () => ({ services: ['github'] })) })
    w = await panel(api)
    await row(w, 'github').get('[data-test="tcx-connect"]').trigger('click')
    expect(api.connect).toHaveBeenCalledWith('github')
  })

  it('when the server cannot be asked, nothing is claimed: the click says what is wrong', async () => {
    const api = fake({ services: vi.fn(async () => ({ services: null })), connect: vi.fn(async () => ({ ...blank, error: 'offline' })) })
    w = await panel(api)
    expect(w.find('[data-test="tcx-not-yet"]').exists()).toBe(false)
    expect(w.findAll('[data-test="tcx-connect"]')).toHaveLength(ALL.length)
    await row(w, 'github').get('[data-test="tcx-connect"]').trigger('click')
    await flushPromises()
    expect(w.get('[data-test="tcx-error"]').text()).toContain('Could not reach tesselcode.com')
  })

  it('a failed question is one it could not ask', async () => {
    w = await panel(fake({ services: vi.fn(async () => Promise.reject(new Error('no'))) }))
    expect(w.findAll('[data-test="tcx-connect"]')).toHaveLength(ALL.length)
  })

  it('offers nothing to press until it knows', async () => {
    let answerIt
    const api = fake({ services: vi.fn(() => new Promise((r) => (answerIt = r))) })
    w = await panel(api)
    expect(w.findAll('[data-test="tcx-connect"]')).toHaveLength(0)
    expect(w.find('[data-test="tcx-not-yet"]').exists()).toBe(false)
    answerIt({ services: ['google'] })
    await flushPromises()
    expect(w.findAll('[data-test="tcx-connect"]')).toHaveLength(1)
  })

  it('an account stays listed with its way out, even for a service no longer ready, as the service writes it', async () => {
    const api = fake({ view: vi.fn(async () => ({ ...blank, connections: [{ service: 'notion', account: 'acme notes (1a2b3c4d)', label: 'Acme Notes (1a2b3c4d)', connectedAt: 1, reconnect: true }] })) })
    w = await panel(api)
    const notion = row(w, 'notion')
    expect(notion.get('[data-test="tcx-account"]').text()).toContain('Acme Notes (1a2b3c4d)')
    expect(notion.find('[data-test="tcx-reconnect"]').exists()).toBe(true)
    await notion.get('[data-test="tcx-disconnect"]').trigger('click')
    expect(api.disconnect).toHaveBeenCalledWith({ service: 'notion', account: 'acme notes (1a2b3c4d)' })
  })

  it('a service with accounts offers another when it is ready', async () => {
    w = await panel(fake({ view: vi.fn(async () => ({ ...blank, connections: [{ service: 'google', account: 'me@mail.example', connectedAt: 1, reconnect: false }] })) }))
    expect(row(w, 'google').get('[data-test="tcx-connect"]').text()).toContain('Connect another account')
    expect(row(w, 'google').text()).toContain('me@mail.example')
  })

  it('says where to end what could not be ended, for each service', async () => {
    const api = fake({ disconnect: vi.fn(async () => ({ ...blank, notEnded: [{ service: 'microsoft', how: 'byHand' }, { service: 'dropbox', how: 'notTold' }] })), view: vi.fn(async () => ({ ...blank, connections: [{ service: 'microsoft', account: 'a', connectedAt: 1, reconnect: false }] })) })
    w = await panel(api)
    await row(w, 'microsoft').get('[data-test="tcx-disconnect"]').trigger('click')
    await flushPromises()
    const lines = w.findAll('[data-test="tcx-not-ended"]').map((x) => x.text())
    expect(lines[0]).toContain('Microsoft gives apps no way to end an access')
    expect(lines[0]).toContain('https://account.live.com/consent/Manage')
    expect(lines[1]).toContain('Dropbox could not be told')
    expect(lines[1]).toContain('https://www.dropbox.com/account/connected_apps')
  })

  it('every service has a place to end it', async () => {
    const api = fake({ view: vi.fn(async () => ({ ...blank, notEnded: ALL.map((service) => ({ service, how: 'byHand' })) })) })
    w = await panel(api)
    for (const line of w.findAll('[data-test="tcx-not-ended"]').map((x) => x.text())) expect(line).toMatch(/To end it now, \S+/)
    expect(w.findAll('[data-test="tcx-not-ended"]')).toHaveLength(ALL.length)
  })

  it('without an account, connecting says so', async () => {
    const api = fake({ connect: vi.fn(async () => ({ ...blank, error: 'signedOut' })) })
    w = await panel(api)
    await row(w, 'google').get('[data-test="tcx-connect"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="tcx-signed-out"]').exists()).toBe(true)
  })
})
