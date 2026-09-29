// The diff card, the inline diff and the turn rollup (after Orca's
// NativeChatDiffCard.tsx, NativeChatDiffView.tsx, NativeChatTurnDiffRollup.tsx,
// MIT, Copyright (c) 2026 Lovecast Inc.; the reference tests them through
// NativeChatToolRun.test.tsx — these cover what the run spec does not).
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { defineComponent, h, nextTick } from 'vue'
import NativeChatDiffCard from '../NativeChatDiffCard.vue'
import NativeChatDiffView from '../NativeChatDiffView.vue'
import NativeChatTurnDiffRollup from '../NativeChatTurnDiffRollup.vue'
import { provideNativeChatDisclosures } from '../../../../chat/orca/composables/native-chat-disclosure-store.js'
import { buttonNamed, byText, clickEvent, queryByText } from './native-chat-tool-test-dom.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
})

function render(component, props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(component, { props, attachTo: container })
  return { container }
}

const file = {
  path: '/repo/src/app.ts',
  changeKind: 'edited',
  added: 2,
  removed: 1,
  truncated: false,
  lineNumbersKnown: true,
  lines: [
    { kind: 'context', text: 'ctx', oldLineNumber: 9, newLineNumber: 9 },
    { kind: 'del', text: 'was', oldLineNumber: 10 },
    { kind: 'add', text: 'now', newLineNumber: 10 },
    { kind: 'gap' },
    { kind: 'add', text: 'tail', newLineNumber: 120 }
  ]
}

describe('NativeChatDiffCard', () => {
  it('shows the verb, the base name with its full path, the counts, and no rows while closed', () => {
    const { container } = render(NativeChatDiffCard, { file })
    expect(queryByText(container, 'Edited file')).not.toBeNull()
    expect(byText(container, 'app.ts').getAttribute('title')).toBe('/repo/src/app.ts')
    expect(container.textContent).toContain('+2')
    expect(container.textContent).toContain('-1')
    expect(queryByText(container, 'was')).toBeNull()
    expect(byText(container, 'Edited file').closest('button').getAttribute('aria-expanded')).toBe('false')
  })

  it('opens to numbered rows with a region break, the gutter sized to the widest number', async () => {
    const { container } = render(NativeChatDiffCard, { file })
    clickEvent(byText(container, 'Edited file').closest('button'))
    await nextTick()
    const gutter = byText(container, 'now').closest('div').querySelector('.nc-diff-card__gutter')
    expect(gutter.textContent).toBe('10')
    expect(gutter.style.width).toBe('4ch')
    expect(container.querySelectorAll('[role="separator"]')).toHaveLength(1)
    // Focusable, so the rows scroll from the keyboard.
    expect(container.querySelector('.nc-diff-card__rows').getAttribute('tabindex')).toBe('0')
  })

  it('names a rename from the old base name to the new one', () => {
    const { container } = render(NativeChatDiffCard, {
      file: { ...file, changeKind: 'renamed', oldPath: 'src/old.ts', path: 'src/new.ts' }
    })
    expect(queryByText(container, 'Renamed file')).not.toBeNull()
    expect(byText(container, 'old.ts').classList).toContain('nc-diff-card__old-path')
    expect(queryByText(container, 'new.ts')).not.toBeNull()
  })

  it('opens and reports itself when asked to reveal, and again on a new request', async () => {
    const onReveal = vi.fn()
    const { container } = render(NativeChatDiffCard, { file, revealSignal: 1, onReveal })
    await nextTick()
    expect(onReveal).toHaveBeenCalledTimes(1)
    expect(onReveal.mock.calls[0][0].classList).toContain('nc-diff-card')
    expect(queryByText(container, 'was')).not.toBeNull()

    await wrapper.setProps({ revealSignal: 2 })
    await nextTick()
    expect(onReveal).toHaveBeenCalledTimes(2)
  })

  it('remembers an opened card under its key while unmounted', async () => {
    const Host = defineComponent({
      props: { mounted: Boolean },
      setup(props) {
        provideNativeChatDisclosures()
        return () => (props.mounted ? h(NativeChatDiffCard, { file, disclosureKey: 'diff:m1:Edit:0:0' }) : null)
      }
    })
    const { container } = render(Host, { mounted: true })
    clickEvent(byText(container, 'Edited file').closest('button'))
    await nextTick()
    await wrapper.setProps({ mounted: false })
    await wrapper.setProps({ mounted: true })
    expect(queryByText(container, 'was')).not.toBeNull()
  })
})

describe('NativeChatDiffView', () => {
  it('signs each row and keeps it as text', () => {
    const { container } = render(NativeChatDiffView, {
      lines: [
        { kind: 'meta', text: '@@ -1 +1 @@' },
        { kind: 'del', text: '<b>old</b>' },
        { kind: 'add', text: 'new' },
        { kind: 'context', text: 'same' }
      ]
    })
    const rows = [...container.querySelectorAll('.nc-diff-view__line')].map((row) => row.textContent)
    expect(rows).toEqual([' @@ -1 +1 @@', '-<b>old</b>', '+new', ' same'])
    expect(container.querySelector('b')).toBeNull()
    expect(container.querySelector('.nc-diff-view__line--add')).not.toBeNull()
  })
})

describe('NativeChatTurnDiffRollup', () => {
  const diff = {
    added: 7,
    removed: 2,
    truncated: true,
    files: [
      { path: 'src/a.ts', added: 5, removed: 2, target: { editKey: 'Edit:0', fileIndex: 0 } },
      { path: 'src/b.ts', added: 2, removed: 0, target: { editKey: 'Write:1', fileIndex: 0 } }
    ]
  }

  it('sums the turn and reveals a file from its list', async () => {
    const onReveal = vi.fn()
    const { container } = render(NativeChatTurnDiffRollup, { diff, onReveal })
    const trigger = buttonNamed(container, /2 changed files/)
    expect(trigger.textContent).toContain('+7')
    expect(trigger.textContent).toContain('Partial diff')
    expect(trigger.getAttribute('aria-expanded')).toBe('false')
    clickEvent(trigger)
    await nextTick()
    expect(queryByText(container, 'Totals from recorded edits in this turn.')).not.toBeNull()
    clickEvent(buttonNamed(container, /src\/b\.ts/))
    expect(onReveal).toHaveBeenCalledWith({ editKey: 'Write:1', fileIndex: 0 })
  })

  it('says one changed file in the singular', () => {
    const { container } = render(NativeChatTurnDiffRollup, { diff: { ...diff, truncated: false, files: [diff.files[0]] } })
    expect(buttonNamed(container, /1 changed file/).textContent).not.toContain('Partial diff')
  })
})
