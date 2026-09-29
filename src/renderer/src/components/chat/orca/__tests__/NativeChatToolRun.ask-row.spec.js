// After Orca's NativeChatToolRun.ask-row.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import NativeChatToolRun from '../NativeChatToolRun.vue'
import { provideNativeChatDisclosures } from '../../../../chat/orca/composables/native-chat-disclosure-store.js'
import { buttonNamed, byText, clickEvent, queryByText } from './native-chat-tool-test-dom.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

const QUESTION = 'What would you like me to do next in this repo?'
const ASK_INPUT = { questions: [{ question: QUESTION }] }

function askBlocks(state) {
  return [{ type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state }]
}

function render(component, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(component, { props, attachTo: container })
  return { container }
}

/** Lays every element out wider than its box, as a long question is on its line. */
function clipEveryLine() {
  const originals = ['scrollWidth', 'clientWidth'].map((name) => [
    name,
    Object.getOwnPropertyDescriptor(HTMLElement.prototype, name)
  ])
  Object.defineProperty(HTMLElement.prototype, 'scrollWidth', { configurable: true, get: () => 400 })
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', { configurable: true, get: () => 100 })
  return () => {
    for (const [name, original] of originals) {
      if (original) Object.defineProperty(HTMLElement.prototype, name, original)
      else Reflect.deleteProperty(HTMLElement.prototype, name)
    }
  }
}

const DisclosureHarness = defineComponent({
  props: { mounted: { type: Boolean, required: true } },
  setup(props) {
    provideNativeChatDisclosures()
    return () =>
      props.mounted
        ? h(NativeChatToolRun, {
            blocks: askBlocks('completed'),
            expandSignal: true,
            activeTurnIsWorking: false,
            disclosureId: 'message-1'
          })
        : null
  }
})

async function click(element) {
  clickEvent(element)
  await nextTick()
}

describe('NativeChatToolRun awaiting-input row', () => {
  it('does not revive stale tool state after a turn stops', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: askBlocks('running'),
      expandSignal: true,
      activeTurnIsWorking: false
    })
    expect(queryByText(container, 'Awaiting user input:')).toBeNull()
    expect(queryByText(container, 'Asked:')).not.toBeNull()
  })

  it('keeps a pending question visible alongside another active tool', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [...askBlocks('running'), { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'running' }],
      expandSignal: true,
      activeTurnIsWorking: true
    })
    expect(queryByText(container, 'Awaiting user input:')).not.toBeNull()
    expect(queryByText(container, 'Reading 1 file')).not.toBeNull()
    expect(queryByText(container, 'Read a.ts')).not.toBeNull()
  })

  it('preserves errors from failed question calls', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [
        { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'failed' },
        { type: 'tool-result', output: 'Question rejected', isError: true }
      ],
      expandSignal: true,
      activeTurnIsWorking: false
    })
    expect(queryByText(container, 'Awaiting user input:')).toBeNull()
    expect(queryByText(container, 'Asked:')).toBeNull()
    expect(container.textContent).toContain('Question rejected')
  })

  it('replaces a running ask call with the awaiting row', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: askBlocks('running'),
      expandSignal: true,
      activeTurnIsWorking: true
    })

    expect(byText(container, 'Awaiting user input:').classList).toContain('nc-animate-pulse')
    expect(queryByText(container, QUESTION)).not.toBeNull()
    expect(container.querySelector('.lucide-message-square-more')).not.toBeNull()
    // The raw call and its payload are exactly what this row exists to replace.
    expect(container.textContent).not.toMatch(/Running AskUserQuestion/)
    expect(container.textContent).not.toMatch(/AskUserQuestion/)
  })

  it('reports a settled ask without the pulse or a tool-count header', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: askBlocks('completed'),
      expandSignal: true,
      activeTurnIsWorking: false
    })

    expect(byText(container, 'Asked:').classList).not.toContain('nc-animate-pulse')
    expect(queryByText(container, QUESTION)).not.toBeNull()
    // A run that is only the ask has no work left to head, so it draws no header.
    expect(container.querySelector('[data-native-chat-tool-run-state]')).toBeNull()
  })

  it('leaves a question that fits on its line as plain text', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: askBlocks('completed'),
      expandSignal: true,
      activeTurnIsWorking: false
    })
    expect(byText(container, QUESTION).classList).toContain('nc-truncate')
    expect(container.querySelector('button')).toBeNull()
  })

  it('opens a clipped question below the toggle and folds it back', async () => {
    const restore = clipEveryLine()
    try {
      const { container } = render(NativeChatToolRun, {
        blocks: askBlocks('completed'),
        expandSignal: true,
        activeTurnIsWorking: false
      })
      await nextTick()
      const toggle = buttonNamed(container, /Asked:/)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')

      await click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      const full = byText(container, QUESTION)
      expect(full.classList).not.toContain('nc-truncate')
      // Outside the button, so it selects like prose and a click in it keeps it open.
      expect(full.closest('button')).toBeNull()
      await click(full)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')

      await click(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
      expect(byText(container, QUESTION).classList).toContain('nc-truncate')
    } finally {
      restore()
    }
  })

  it('keeps an opened question open when the windowed row remounts', async () => {
    const restore = clipEveryLine()
    try {
      const { container } = render(DisclosureHarness, { mounted: true })
      await nextTick()
      await click(buttonNamed(container, /Asked:/))

      await wrapper.setProps({ mounted: false })
      expect(queryByText(container, QUESTION)).toBeNull()
      await wrapper.setProps({ mounted: true })

      const toggle = buttonNamed(container, /Asked:/)
      expect(toggle.getAttribute('aria-expanded')).toBe('true')
      expect(byText(container, QUESTION).closest('button')).toBeNull()

      // Folding it keeps the same control, so keyboard focus is not dropped.
      toggle.focus()
      await click(toggle)
      expect(document.activeElement).toBe(toggle)
      expect(toggle.getAttribute('aria-expanded')).toBe('false')
    } finally {
      restore()
    }
  })

  it('offers no expansion when the row names only a question count', async () => {
    const restore = clipEveryLine()
    try {
      const input = { questions: [{ question: 'First?' }, { question: 'Second?' }] }
      const { container } = render(NativeChatToolRun, {
        blocks: [{ type: 'tool-call', name: 'AskUserQuestion', input, state: 'completed' }],
        expandSignal: true,
        activeTurnIsWorking: false
      })
      await nextTick()
      expect(queryByText(container, '2 questions')).not.toBeNull()
      expect(container.querySelector('button')).toBeNull()
    } finally {
      restore()
    }
  })

  it('counts only the work that ran in the header beside the ask', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [
        { type: 'tool-call', name: 'Read', input: { file_path: 'a.ts' }, state: 'completed' },
        { type: 'tool-call', name: 'AskUserQuestion', input: ASK_INPUT, state: 'running' }
      ],
      expandSignal: true,
      activeTurnIsWorking: true
    })

    expect(queryByText(container, 'Awaiting user input:')).not.toBeNull()
    // One call ran; being asked a question is not work to summarize. The agent
    // is blocked on the reader, so the run reads settled, not in progress.
    expect(queryByText(container, 'Read 1 file')).not.toBeNull()
    expect(queryByText(container, 'Reading 1 file')).toBeNull()
  })

  it('draws the row from the tool name when the payload names no question', () => {
    const { container } = render(NativeChatToolRun, {
      blocks: [{ type: 'tool-call', name: 'request_user_input', input: {}, state: 'running' }],
      expandSignal: true,
      activeTurnIsWorking: true
    })

    expect(queryByText(container, 'Awaiting user input:')).not.toBeNull()
    expect(container.textContent).not.toMatch(/request_user_input/)
  })
})
