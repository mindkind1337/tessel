// After Orca's NativeChatBackgroundTasksStatus.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick, ref } from 'vue'
import NativeChatBackgroundTasksStatus from '../NativeChatBackgroundTasksStatus.vue'
import { clickEvent, queryByText } from './native-chat-tool-test-dom.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  vi.useRealTimers()
})

/** The strip's disclosure is parent-owned, because the strip unmounts whenever
 *  live work momentarily drops to nothing; this stands in for that owner. */
const DisclosureHost = defineComponent({
  inheritAttrs: false,
  setup(_props, { attrs }) {
    const expanded = ref(false)
    return () =>
      h(NativeChatBackgroundTasksStatus, {
        ...attrs,
        expanded: expanded.value,
        onExpandedChange: (next) => {
          expanded.value = next
        }
      })
  }
})

function render(props, component = DisclosureHost) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(component, { props, attachTo: container })
  return { container }
}

function collapsedHeader(container) {
  return container.querySelector('button[aria-expanded="false"]')
}

async function expand(container) {
  clickEvent(collapsedHeader(container))
  await nextTick()
}

function byLabel(container, label) {
  return container.querySelector(`[aria-label="${label}"]`)
}

function listNamed(container, name) {
  return container.querySelector(`[role="list"][aria-label="${name}"]`)
}

const TASKS = [
  { id: 'codex-agent:child-1', kind: 'agent', description: 'count_a' },
  { id: 'codex-command:exec-1', kind: 'command', description: 'sleep 90' }
]

async function renderStrip({ supportsTaskStop, supportsStopAll }) {
  const onStop = vi.fn()
  const { container } = render({
    isVisible: true,
    tasks: TASKS,
    settledTasks: [],
    indicatorActive: true,
    supportsTaskStop,
    supportsStopAll,
    stoppingTaskIds: new Set(),
    stoppingAll: false,
    onStop
  })
  await expand(container)
  return { container, onStop }
}

describe('NativeChatBackgroundTasksStatus stop affordances', () => {
  it('offers a per-task stop on a host that accepts targeted stops', async () => {
    const { container, onStop } = await renderStrip({ supportsTaskStop: true, supportsStopAll: true })
    expect(byLabel(container, 'Stop count_a')).not.toBeNull()
    expect(byLabel(container, 'Stop background tasks')).toBeNull()
    clickEvent(byLabel(container, 'Stop count_a'))
    expect(onStop).toHaveBeenCalledWith('codex-agent:child-1')
  })

  it('falls back to a stop-all on a host that only accepts an untargeted stop', async () => {
    const { container, onStop } = await renderStrip({ supportsTaskStop: false, supportsStopAll: true })
    expect(byLabel(container, 'Stop background tasks')).not.toBeNull()
    clickEvent(byLabel(container, 'Stop background tasks'))
    expect(onStop).toHaveBeenCalledWith()
  })

  it('withholds a row stop the host reported it cannot act on', async () => {
    // A row published with `stoppable: false` has no target for a Stop.
    const { container } = render({
      isVisible: true,
      tasks: [
        { id: 'fore-1', kind: 'agent', description: 'in-turn subagent', stoppable: false },
        { id: 'back-1', kind: 'agent', description: 'backgrounded subagent' }
      ],
      settledTasks: [],
      indicatorActive: true,
      supportsTaskStop: true,
      supportsStopAll: true,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      onStop: vi.fn()
    })
    await expand(container)

    expect(queryByText(container, 'in-turn subagent')).not.toBeNull()
    expect(byLabel(container, 'Stop in-turn subagent')).toBeNull()
    expect(byLabel(container, 'Stop backgrounded subagent')).not.toBeNull()
  })

  it('offers no stop at all when the provider exposes none', async () => {
    // Codex: a Stop button here would be a control that cannot act.
    const { container } = await renderStrip({ supportsTaskStop: false, supportsStopAll: false })
    expect(byLabel(container, 'Stop background tasks')).toBeNull()
    expect(byLabel(container, 'Stop count_a')).toBeNull()
    expect(queryByText(container, 'count_a')).not.toBeNull()
    expect(queryByText(container, 'sleep 90')).not.toBeNull()
  })

  it('disables the stop of a task already stopping', async () => {
    const { container } = render({
      isVisible: true,
      tasks: TASKS,
      settledTasks: [],
      indicatorActive: true,
      supportsTaskStop: true,
      supportsStopAll: true,
      stoppingTaskIds: new Set(['codex-agent:child-1']),
      stoppingAll: false,
      onStop: vi.fn()
    })
    await expand(container)
    expect(byLabel(container, 'Stop count_a').disabled).toBe(true)
    expect(byLabel(container, 'Stop sleep 90').disabled).toBe(false)
  })
})

describe('background-tasks strip header', () => {
  function renderHeader(tasks, indicatorActive = true) {
    const { container } = render({
      isVisible: true,
      tasks,
      settledTasks: [],
      indicatorActive,
      supportsTaskStop: false,
      supportsStopAll: false,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      onStop: () => {}
    })
    return { container, header: collapsedHeader(container) }
  }

  it('leads each kind segment with that kind icon and keeps the counts in the accessible name', () => {
    const { header } = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'a2', kind: 'agent' },
      { id: 'a3', kind: 'agent' },
      { id: 'm1', kind: 'monitor' }
    ])
    expect(header.getAttribute('aria-label')).toBe('3 agents · 1 monitor')
    expect(header.querySelector('.lucide-bot')).not.toBeNull()
    // Heartbeat, the same glyph the agent sidebar shows for monitoring.
    expect(header.querySelector('.lucide-activity')).not.toBeNull()
    // Two kind icons and the chevron: no aggregate state dot.
    expect(header.querySelectorAll('svg')).toHaveLength(3)
    for (const icon of header.querySelectorAll('svg')) {
      expect(icon.getAttribute('aria-hidden')).toBe('true')
    }
  })

  it('gives the monitor heartbeat the sidebar amber and leaves other kinds neutral', () => {
    const { header } = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'm1', kind: 'monitor' }
    ])
    expect(header.querySelector('.lucide-activity').classList).toContain('nc-kind-tone--monitor')
    expect(header.querySelector('.lucide-bot').classList).toContain('nc-kind-tone--muted')
    expect(header.querySelector('.lucide-bot').classList).not.toContain('nc-kind-tone--monitor')
  })

  it('dims the monitor amber while a turn owns the voice', () => {
    const { header } = renderHeader([{ id: 'm1', kind: 'monitor' }], false)
    const icon = header.querySelector('.lucide-activity')
    expect(icon.classList).toContain('nc-kind-tone--monitor')
    expect(icon.classList).toContain('nc-kind-tone--dimmed')
  })

  it('carries the monitor amber on the expanded row too', async () => {
    const { container, header } = renderHeader([
      { id: 'm1', kind: 'monitor', description: 'watcher' },
      { id: 'c1', kind: 'command', description: 'sleep 90' }
    ])
    clickEvent(header)
    await nextTick()
    // Each kind group is its own labelled list, so scope to the monitor one.
    const monitors = listNamed(container, 'Monitors')
    expect(monitors.querySelector('.lucide-activity').classList).toContain('nc-kind-tone--monitor')
    expect(monitors.querySelector('.lucide-activity').classList).not.toContain('nc-kind-tone--dimmed')
    const shell = listNamed(container, 'Shell')
    expect(shell.querySelector('.lucide-square-terminal').classList).toContain('nc-kind-tone--muted')
  })

  it('draws the segment separator in a visible text tone, not the divider token', () => {
    const { header } = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'c1', kind: 'command' }
    ])
    const separators = [...header.querySelectorAll('span')].filter((element) => element.textContent === ' · ')
    expect(separators).toHaveLength(1)
    expect(separators[0].classList).toContain('nc-bg-tasks__separator')
    // One space either side; the icon's own margin is the icon-to-label gap.
    expect(header.textContent).toBe('1 agent · 1 shell')
  })

  it('carries no icon on a collapsed total, which spans kinds', () => {
    const { header } = renderHeader([
      { id: 'a1', kind: 'agent' },
      { id: 'c1', kind: 'command' },
      { id: 'm1', kind: 'monitor' },
      { id: 'w1', kind: 'workflow' }
    ])
    expect(header.getAttribute('aria-label')).toBe('4 background tasks')
    expect(header.querySelectorAll('svg')).toHaveLength(1)
  })

  it('points the header at the roster it opens', async () => {
    const { container, header } = renderHeader([{ id: 'a1', kind: 'agent', description: 'child' }])
    clickEvent(header)
    await nextTick()
    const list = document.getElementById(header.getAttribute('aria-controls'))
    expect(list).not.toBeNull()
    expect(header.getAttribute('aria-expanded')).toBe('true')
  })
})

describe('settled rows beside their live siblings', () => {
  // A finished child stays visible, keeps the usage it ended on, and stops
  // claiming a clock or a stop control.
  it('keeps a settled row with its final usage, no clock and no stop', async () => {
    const { container } = render({
      isVisible: true,
      tasks: [{ id: 'agent-live', kind: 'agent', description: 'live child', startedAt: 1_000, totalTokens: 4_100 }],
      settledTasks: [
        { id: 'agent-settled', kind: 'agent', description: 'settled child', state: 'done', startedAt: 500, totalTokens: 18_130 }
      ],
      indicatorActive: true,
      supportsTaskStop: true,
      supportsStopAll: true,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      onStop: () => {}
    })
    await expand(container)
    const rows = listNamed(container, 'Agents').querySelectorAll('li')
    expect(rows).toHaveLength(2)
    // First seen first: the settled sibling started earlier.
    expect(rows[0].textContent).toBe('settled child18.1k')
    expect(rows[1].textContent).toMatch(/^live child4\.1k · .+Stop$/)
    expect(rows[1].querySelector('button[aria-label="Stop live child"]')).not.toBeNull()
    expect(rows[0].querySelector('button')).toBeNull()
  })
})

describe('background-task row reasons', () => {
  // `unverifiable` is the verdict for "no contact"; a row that hides it reads
  // like a working child. `blocked` is the same class of loss.
  it('names the reason on every attention state, not only on waiting', async () => {
    const { container } = render({
      isVisible: true,
      tasks: [
        { id: 'a1', kind: 'agent', description: 'ssh child', state: 'unverifiable' },
        { id: 'a2', kind: 'agent', description: 'flaky child', state: 'blocked' },
        { id: 'a3', kind: 'agent', description: 'approval child', state: 'waiting' },
        { id: 'a4', kind: 'agent', description: 'busy child', state: 'working' }
      ],
      settledTasks: [],
      indicatorActive: true,
      supportsTaskStop: false,
      supportsStopAll: false,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      onStop: () => {}
    })
    await expand(container)
    const rows = container.querySelectorAll('li')
    expect(rows).toHaveLength(4)
    expect(rows[0].textContent).toContain('ssh child · no contact')
    expect(rows[1].textContent).toContain('flaky child · failed')
    expect(rows[2].textContent).toContain('approval child · needs approval')
    // A running row has nothing to explain.
    expect(rows[3].textContent).not.toContain('·')
  })

  it('masks a secret in a task named by its command (Tessel)', async () => {
    const { container } = render({
      isVisible: true,
      tasks: [{ id: 'c1', kind: 'command', description: 'deploy --token=s3cr3tvalue' }],
      settledTasks: [],
      indicatorActive: true,
      supportsTaskStop: true,
      supportsStopAll: false,
      stoppingTaskIds: new Set(),
      stoppingAll: false,
      onStop: () => {}
    })
    await expand(container)
    expect(container.textContent).not.toContain('s3cr3tvalue')
    expect(container.textContent).toContain('deploy --token=***')
    expect(container.innerHTML).not.toContain('s3cr3tvalue')
  })
})

// The reference counted React commits with a Profiler; here the header's own
// clock text says whether the 1 Hz tick ran.
it('stops elapsed renders in a hidden pane and catches up on reveal', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(100_000)
  const props = {
    expanded: false,
    onExpandedChange: () => {},
    isVisible: true,
    tasks: [{ id: 'shell', kind: 'command', startedAt: 1_000 }],
    settledTasks: [],
    indicatorActive: true,
    supportsTaskStop: false,
    supportsStopAll: false,
    stoppingTaskIds: new Set(),
    stoppingAll: false,
    onStop: () => {}
  }
  const { container } = render(props, NativeChatBackgroundTasksStatus)
  const label = () => container.querySelector('button').getAttribute('aria-label')
  expect(label()).toBe('1 shell command — 1m 39s')
  vi.advanceTimersByTime(1_000)
  await nextTick()
  expect(label()).toBe('1 shell command — 1m 40s')
  await wrapper.setProps({ isVisible: false })
  vi.advanceTimersByTime(10_000)
  await nextTick()
  expect(label()).toBe('1 shell command — 1m 40s')
  await wrapper.setProps({ isVisible: true })
  expect(label()).toBe('1 shell command — 1m 50s')
  vi.advanceTimersByTime(1_000)
  await nextTick()
  expect(label()).toBe('1 shell command — 1m 51s')
  wrapper.unmount()
  wrapper = null
  expect(vi.getTimerCount()).toBe(0)
})
