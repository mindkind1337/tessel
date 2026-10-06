// A remote project shown when Tessel starts: its Files / Changes are refused
// until the host is connected (src/main/remoteFs.js); the remote badge says
// "Not connected" and offers Connect; once connected they read it again.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import RemoteBadge from '../components/project/RemoteBadge.vue'
import SidePanel from '../components/SidePanel.vue'
import { remoteHostsState, noteRemoteActivity, hostShared } from '../remoteHosts'

const HOST = 'ssh-box'
const ROOT = 'ssh://ssh-box/srv/app'

let connect
beforeEach(() => {
  for (const k of Object.keys(remoteHostsState.needsConnect)) delete remoteHostsState.needsConnect[k]
  remoteHostsState.states = {}
  connect = vi.fn(async () => ({ ok: true }))
  window.shellApi = {
    remoteFs: {
      connect,
      cancel: vi.fn(async () => ({ ok: true })),
      state: vi.fn(async () => ({ ok: true, sessions: {} })),
      onActivity: () => () => {}
    },
    explorer: {
      list: vi.fn(async () => ({ ok: false, error: 'Box is not connected. Use Connect to sign in.' })),
      status: vi.fn(async () => ({ ok: false })),
      searchNames: vi.fn(async () => ({ ok: true, results: [] })),
      searchContent: vi.fn(async () => ({ ok: true, results: [] })),
      watch: vi.fn(async () => ({ ok: true })),
      unwatch: vi.fn(async () => ({ ok: true })),
      onChanged: () => () => {}
    },
    scm: { status: vi.fn(async () => ({ ok: false, error: 'not connected' })) }
  }
})
afterEach(() => {
  delete window.shellApi
})

describe('the needsConnect state', () => {
  it('a refused operation marks the host; a session signed in clears it', () => {
    noteRemoteActivity({ hostId: HOST, state: 'closed', needsConnect: true })
    expect(remoteHostsState.needsConnect[HOST]).toBe(true)
    noteRemoteActivity({ hostId: HOST, state: 'connecting' })
    expect(remoteHostsState.needsConnect[HOST]).toBe(true)
    noteRemoteActivity({ hostId: HOST, state: 'ready' })
    expect(remoteHostsState.needsConnect[HOST]).toBeUndefined()
  })
  it('the shared connection is read from the host states', () => {
    expect(hostShared(HOST, { [HOST]: { status: 'connected', shared: true } })).toBe(true)
    expect(hostShared(HOST, { [HOST]: { status: 'connected' } })).toBe(false)
    expect(hostShared(HOST, {})).toBe(false)
  })
})

describe('the remote badge', () => {
  it('offers Connect when the host is not connected, and signs in on click', async () => {
    const w = mount(RemoteBadge, { props: { hostId: HOST, host: 'Box', path: '/srv/app' } })
    expect(w.find('[data-test="remote-connect"]').exists()).toBe(false)
    remoteHostsState.needsConnect[HOST] = true
    await nextTick()
    expect(w.find('[data-test="remote-not-connected"]').text()).toBe('Not connected')
    await w.find('[data-test="remote-connect"]').trigger('click')
    await flushPromises()
    expect(connect).toHaveBeenCalledWith(HOST)
    expect(remoteHostsState.needsConnect[HOST]).toBeUndefined()
    expect(w.find('[data-test="remote-connect"]').exists()).toBe(false)
  })
  it('a cancelled sign-in keeps Connect', async () => {
    connect.mockResolvedValueOnce({ ok: false, cancelled: true, error: 'cancelled' })
    remoteHostsState.needsConnect[HOST] = true
    const w = mount(RemoteBadge, { props: { hostId: HOST, host: 'Box', path: '/srv/app' } })
    await w.find('[data-test="remote-connect"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="remote-connect"]').exists()).toBe(true)
  })
})

describe('Files and Changes once connected', () => {
  it('read the project again after Connect', async () => {
    const w = mount(SidePanel, { props: { tab: 'files', root: ROOT, remote: { hostId: HOST, host: 'Box', path: '/srv/app' } } })
    await flushPromises()
    const listed = window.shellApi.explorer.list.mock.calls.length
    const statused = window.shellApi.scm.status.mock.calls.length
    expect(listed).toBeGreaterThan(0)
    remoteHostsState.needsConnect[HOST] = true
    await nextTick()
    await w.find('[data-test="remote-connect"]').trigger('click')
    await flushPromises()
    expect(window.shellApi.explorer.list.mock.calls.length).toBeGreaterThan(listed)
    expect(window.shellApi.scm.status.mock.calls.length).toBeGreaterThan(statused)
  })
})

describe('a host slow to answer', () => {
  it('the badge says so (with Cancel) instead of the operation name', async () => {
    vi.useFakeTimers()
    let emit
    window.shellApi.remoteFs.onActivity = (fn) => {
      emit = fn
      return () => {}
    }
    const w = mount(RemoteBadge, { props: { hostId: HOST, host: 'Box', path: '/srv/app' } })
    emit({ hostId: HOST, state: 'busy', pending: 1, op: 'list', slow: false })
    await nextTick()
    vi.advanceTimersByTime(500)
    await nextTick()
    expect(w.get('[data-test="remote-busy"]').text()).toContain('Reading the folder')
    emit({ hostId: HOST, state: 'busy', pending: 1, op: 'list', slow: true })
    await nextTick()
    expect(w.get('[data-test="remote-busy"]').text()).toContain('Box is slow to answer')
    expect(w.find('[data-test="remote-cancel"]').exists()).toBe(true)
    w.unmount()
    vi.useRealTimers()
  })
})
