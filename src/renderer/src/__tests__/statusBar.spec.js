// The bottom status bar (Orca's): keep awake, Resource Manager (memory ·
// terminals), live ports, remote hosts; right-click chooses the indicators.
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import StatusBar from '../components/StatusBar.vue'
import { settings, resetSettings } from '../settings'

let mounted = []
const GB = 1024 * 1024 * 1024

function mountBar(props = {}) {
  const w = mount(StatusBar, {
    props: {
      info: { target: 'Input → Claude', summary: '3 panes · 1 working', path: 'C:\\repo' },
      keepAwakeActive: false,
      terminals: [
        { id: 'a', pid: 11, label: '#1 Claude', group: 'Shop / repo', groupKey: 'k1' },
        { id: 't', pid: 12, label: '#2 pwsh', group: 'Shop / repo', groupKey: 'k1' }
      ],
      portGroups: [
        {
          key: 'k1',
          name: 'Shop / repo',
          ports: [{ id: 'p', port: 5173, pid: 4242, processName: 'node.exe', connectHost: 'localhost', kind: 'workspace' }]
        }
      ],
      externalPorts: [{ id: 'e', port: 135, pid: 1188, processName: 'svchost.exe', connectHost: 'localhost', kind: 'external' }],
      ...props
    },
    attachTo: document.body
  })
  mounted.push(w)
  return w
}

beforeEach(() => {
  resetSettings()
  window.shellApi = {
    resourceSnapshot: vi.fn(async () => ({
      ok: true,
      totalMemory: 1.44 * GB,
      totalCpu: 3.2,
      totalPrivateMemory: 1.1 * GB,
      processMemoryMetric: 'working-set',
      sessions: { a: { memory: 0.5 * GB, cpu: 3 } },
      app: {
        main: { memory: 0.2 * GB, cpu: 0 },
        renderer: { memory: 0.3 * GB, cpu: 0.2 },
        other: { memory: 0.1 * GB, cpu: 0 },
        total: { memory: 0.6 * GB, cpu: 0.2 }
      }
    }))
  }
})
afterEach(() => {
  for (const w of mounted) w.unmount()
  mounted = []
  document.body.innerHTML = ''
  delete window.shellApi
})

describe('status bar', () => {
  it('shows keep awake, memory · terminals, ports and hosts, with the former footer on the left', async () => {
    settings.keepAwake = 'agents'
    const w = mountBar()
    await flushPromises()
    expect(w.find('.sb-left').text()).toContain('Input → Claude')
    const awake = w.find('.sb-awake')
    expect(awake.attributes('aria-label')).toBe('Keep computer awake, Agent · Inactive')
    expect(awake.text()).toBe('Agent')
    const [, resources, ports, hosts] = w.findAll('.sb-trigger')
    expect(resources.text()).toBe('1.44 GB·2')
    expect(resources.attributes('aria-label')).toBe('Resource Manager, 2 terminal sessions')
    expect(ports.text()).toBe('1')
    expect(ports.attributes('title')).toBe('Ports — 1 workspace port · 1 external')
    expect(hosts.text()).toBe('0 hosts')
    // One snapshot at start (Orca), terminals' pids passed along.
    expect(window.shellApi.resourceSnapshot).toHaveBeenCalledWith({ ptys: [{ id: 'a', pid: 11 }, { id: 't', pid: 12 }] })
  })

  it('keep awake menu: On / Agent / Off with their descriptions', async () => {
    const w = mountBar()
    await w.find('.sb-awake').trigger('click')
    const menu = document.querySelector('.orca-menu')
    expect(menu.textContent).toContain('Keep computer awake')
    expect(menu.textContent).toContain('Keep this computer awake continuously')
    expect(menu.textContent).toContain('Stay awake while an agent is working')
    expect(menu.textContent).toContain('Allow normal system sleep behavior')
    ;[...menu.querySelectorAll('[role="menuitemradio"]')].find((b) => b.textContent.includes('On')).click()
    expect(settings.keepAwake).toBe('on')
  })

  it('Resource Manager popover: totals, sessions by workspace, a click goes to the pane', async () => {
    const w = mountBar()
    await flushPromises()
    await w.findAll('.sb-trigger')[1].trigger('click')
    await flushPromises()
    const pop = document.querySelector('.sb-resources')
    expect(pop.textContent).toContain('Resource Manager')
    expect(pop.textContent).toContain('1.44 GB')
    expect(pop.textContent).toContain('Σ WS')
    expect(pop.textContent).toContain('Σ Private')
    expect(pop.textContent).toContain('Shop / repo')
    pop.querySelector('.sb-res-row.session').click()
    expect(w.emitted('focus-pane')[0]).toEqual(['a'])
  })

  it('Ports popover: workspace groups, Go to Worktree, collapsed External Ports', async () => {
    const w = mountBar()
    await w.findAll('.sb-trigger')[2].trigger('click')
    await flushPromises()
    const pop = document.querySelector('.sb-ports')
    expect(pop.textContent).toContain('1 workspace · 1 external')
    expect(pop.textContent).toContain('5173')
    expect(pop.textContent).not.toContain('svchost.exe')
    pop.querySelector('.sb-external-toggle').click()
    await flushPromises()
    expect(document.querySelector('.sb-ports').textContent).toContain('svchost.exe')
    // An external listener cannot be stopped from here.
    const stops = [...document.querySelectorAll('.sb-ports [aria-label="Stop Process"]')]
    expect(stops.map((b) => b.disabled)).toEqual([false, true])
    document.querySelector('.sb-ports [aria-label="Go to Worktree"]').click()
    expect(w.emitted('activate-card')[0]).toEqual(['k1'])
    expect(w.emitted('refresh-ports')).toBeTruthy()
  })

  it('right-click chooses the indicators (Remote Hosts, Resource Manager, Ports)', async () => {
    const w = mountBar()
    await w.find('.sb-left').trigger('contextmenu', { clientX: 10, clientY: 10 })
    const items = [...document.querySelectorAll('.orca-menu [role="menuitemcheckbox"]')]
    expect(items.map((b) => b.textContent.trim())).toEqual(['Remote Hosts', 'Resource Manager', 'Ports'])
    items[2].click()
    await flushPromises()
    expect(settings.statusBarItems).toEqual(['ssh', 'resource-usage'])
    expect(w.findAll('.sb-trigger')).toHaveLength(3)
  })
})
