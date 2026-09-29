// After Orca's NativeChatSubagentRun.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import NativeChatSubagentRun from '../NativeChatSubagentRun.vue'
import NativeChatToolRun from '../NativeChatToolRun.vue'
import { queryByText } from './native-chat-tool-test-dom.js'

let wrappers = []
afterEach(() => {
  for (const wrapper of wrappers) wrapper.unmount()
  wrappers = []
  document.body.innerHTML = ''
})

function render(component, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrappers.push(mount(component, { props, attachTo: container }))
  return { container, button: () => container.querySelector('button') }
}

function group(agents) {
  return { type: 'subagent-group', groupId: 'thread:turn-1', agents }
}

describe('NativeChatSubagentRun', () => {
  it('reads as a live spawn while children work', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([
        { id: 'a', label: 'read', state: 'working' },
        { id: 'b', label: 'search', state: 'completed', tokens: 40661 }
      ])
    })

    expect(queryByText(container, 'Kicked off 2 subagents')).not.toBeNull()
    expect(button().textContent).toContain('1 working')
    expect(button().textContent).toContain('40.7k tokens')
  })

  it('switches to Ran once every child completed', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([
        { id: 'a', label: 'read', state: 'completed' },
        { id: 'b', label: 'search', state: 'completed' }
      ])
    })

    expect(queryByText(container, 'Ran 2 subagents')).not.toBeNull()
    expect(button().textContent).toContain('completed')
  })

  it('shows the worst settled verdict, not the count of finished children', () => {
    const { button } = render(NativeChatSubagentRun, {
      block: group([
        { id: 'a', label: 'read', state: 'failed' },
        { id: 'b', label: 'search', state: 'failed' },
        { id: 'c', label: 'list', state: 'completed' }
      ])
    })

    expect(button().textContent).toContain('2 failed')
  })

  it('surfaces a failed child while its siblings still work', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([
        { id: 'a', label: 'read', state: 'working' },
        { id: 'b', label: 'search', state: 'working' },
        { id: 'c', label: 'list', state: 'working' },
        { id: 'd', label: 'edit', state: 'failed' }
      ])
    })

    expect(button().textContent).toContain('3 working')
    expect(button().textContent).toContain('+1 failed')
    // The dot carries the failure; the pulse still says the group is in flight.
    expect(container.querySelector('.nc-subagent-dot--failed.nc-animate-pulse')).not.toBeNull()
  })

  it('leaves the dot neutral when nothing has gone wrong', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([
        { id: 'a', label: 'read', state: 'working' },
        { id: 'b', label: 'search', state: 'completed' }
      ])
    })

    expect(button().textContent).not.toContain('failed')
    expect(container.querySelector('.nc-subagent-dot--failed')).toBeNull()
  })

  // A turn boundary says nothing about a child.
  it('keeps a working child working once its turn is no longer the current one', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([{ id: 'a', label: 'read', state: 'working' }])
    })

    expect(button().textContent).toContain('working')
    expect(button().textContent).not.toContain('unverifiable')
    expect(queryByText(container, 'Kicked off 1 subagent')).not.toBeNull()
  })

  it('reports the verdict a child lands after its turn ended', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([{ id: 'a', label: 'read', state: 'completed' }])
    })

    expect(queryByText(container, 'Ran 1 subagent')).not.toBeNull()
    expect(button().textContent).toContain('completed')
  })

  // Only the writing host may claim loss of contact; the renderer draws it.
  it('draws the unverifiable verdict the host recorded', () => {
    const { button } = render(NativeChatSubagentRun, { block: group([{ id: 'a', label: 'read', state: 'unverifiable' }]) })

    expect(button().textContent).toContain('unverifiable')
  })

  it('leads with the bot glyph, decorative beside the word that names the group', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([{ id: 'a', label: 'read', state: 'working' }])
    })

    const glyph = container.querySelector('.lucide-bot')
    expect(glyph).not.toBeNull()
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    // Never icon-only: the word is what carries the accessible name.
    expect(button().textContent).toMatch(/Kicked off 1 subagent/)
  })

  it('keeps the same glyph in every state, so a settling row never changes identity', () => {
    for (const state of ['working', 'idle', 'completed', 'failed', 'stopped', 'unverifiable']) {
      const { container } = render(NativeChatSubagentRun, { block: group([{ id: 'a', label: 'read', state }]) })

      expect(container.querySelectorAll('.lucide-bot')).toHaveLength(1)
      expect(container.querySelector('.lucide-check')).toBeNull()
      expect(container.querySelector('.lucide-users')).toBeNull()
    }
  })

  // The only aria-hidden span carrying text is the elapsed-clock wrapper.
  function hiddenTextSpans(container) {
    return [...container.querySelectorAll('span[aria-hidden="true"]')].filter(
      (element) => (element.textContent ?? '').trim().length > 0
    )
  }

  it('keeps the ticking clock out of the live region until it stops moving', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([{ id: 'a', label: 'read', state: 'working', startedAt: 1_000 }])
    })

    expect(button().getAttribute('aria-live')).toBe('polite')
    // A clock that reticks every second would bury the state changes.
    expect(hiddenTextSpans(container)).toHaveLength(1)
  })

  it('reads the elapsed time out once it has stopped moving', () => {
    const { container, button } = render(NativeChatSubagentRun, {
      block: group([{ id: 'a', label: 'read', state: 'completed', startedAt: 1_000, settledAt: 5_000 }])
    })

    expect(hiddenTextSpans(container)).toHaveLength(0)
    expect(button().textContent).toContain('4s')
  })

  it('shows no duration for a child whose run length was never recorded', () => {
    const { button } = render(NativeChatSubagentRun, {
      block: group([{ id: 'a', label: 'read', state: 'unverifiable', startedAt: 1_000 }])
    })

    expect(button().textContent).toContain('unverifiable')
    expect(button().textContent).not.toContain('·')
  })

  it('shows no duration while one child settled and another is unaccounted for', () => {
    const { button } = render(NativeChatSubagentRun, {
      block: group([
        { id: 'a', label: 'read', state: 'completed', startedAt: 1_000, settledAt: 5_000 },
        { id: 'b', label: 'search', state: 'unverifiable', startedAt: 1_000 }
      ])
    })

    expect(button().textContent).toContain('unverifiable')
    expect(button().textContent).not.toContain('·')
  })
})

describe('NativeChatToolRun with a spawn group', () => {
  it('renders a roster with no tool calls without inventing a tool count', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [],
      subagentGroups: [group([{ id: 'a', label: 'read', state: 'working' }])],
      expandSignal: false,
      activeTurnIsWorking: true
    })

    expect(queryByText(container, 'Kicked off 1 subagent')).not.toBeNull()
    expect(queryByText(container, '1 tool call')).toBeNull()
  })

  it('keeps the roster visible on a completed turn whose activity is collapsed', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [],
      subagentGroups: [group([{ id: 'a', label: 'read', state: 'completed' }])],
      expandSignal: false,
      expandOverride: false,
      activeTurnIsWorking: false
    })

    expect(queryByText(container, 'Ran 1 subagent')).not.toBeNull()
  })

  // A group that draws nothing must not count as a row: its wrapper would be an
  // empty bubble with a margin.
  it('draws nothing at all for a spawn group that carries no children', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [],
      subagentGroups: [group([])],
      expandSignal: false,
      expandOverride: false,
      activeTurnIsWorking: false
    })

    expect(container.querySelector('.nc-tool-run')).toBeNull()
    expect(container.querySelector('button, span, ul')).toBeNull()
    expect(container.textContent).toBe('')
  })

  it('keeps a roster that shares its message with tool calls on a collapsed turn', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' } }],
      subagentGroups: [group([{ id: 'a', label: 'read', state: 'completed' }])],
      expandSignal: false,
      expandOverride: false,
      activeTurnIsWorking: false
    })

    expect(queryByText(container, 'Ran 1 subagent')).not.toBeNull()
    expect(queryByText(container, 'shell')).toBeNull()
  })

  it('renders the roster alongside the tool activity of its turn', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'ls' } }],
      subagentGroups: [group([{ id: 'a', label: 'read', state: 'completed' }])],
      expandSignal: false,
      activeTurnIsWorking: false
    })

    expect(queryByText(container, 'Ran 1 subagent')).not.toBeNull()
    expect(queryByText(container, 'ls').closest('button').textContent).toContain('ls')
  })
})
