// After Orca's components/AgentStateDot.test.ts (MIT, Copyright (c) 2026 Lovecast Inc.).
// Dropped: the main.css contrast-token check (Tessel's tokens live in
// orca-tokens.css / the component) and the TypeScript exhaustiveness guard.
import { afterEach, describe, expect, it } from 'vitest'
import { mount } from '@vue/test-utils'
import AgentStateDot from '../AgentStateDot.vue'
import { lucideName } from './native-chat-tool-test-dom.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
})

function render(props) {
  wrapper = mount(AgentStateDot, { props, attachTo: document.body })
  return wrapper.find('.nc-state-dot').element
}

describe('AgentStateDot', () => {
  it('renders working as a yellow spinner', () => {
    const root = render({ state: 'working', title: null })
    const spinner = root.querySelector('[data-agent-spinner]')
    expect(spinner).not.toBeNull()
    expect(spinner.classList).toContain('nc-state-dot__spinner')
    expect(root.getAttribute('aria-label')).toBe('Working')
  })

  it('renders monitoring as a blue dot, not an icon', () => {
    const root = render({ state: 'monitoring', title: null })
    expect(root.getAttribute('aria-label')).toBe('Monitoring background tasks')
    expect(root.querySelector('svg')).toBeNull()
    expect(root.querySelector('.nc-state-dot__dot--monitoring')).not.toBeNull()
    expect(root.querySelector('[data-agent-spinner]')).toBeNull()
  })

  it('renders done as an emerald check icon', () => {
    const root = render({ state: 'done', title: null })
    const icon = root.querySelector('svg')
    expect(lucideName(icon)).toBe('circle-check')
    expect(icon.classList).toContain('nc-state-dot__icon--done')
  })

  it.each(['permission', 'waiting'])('renders %s as the shared question glyph', (state) => {
    const root = render({ state, title: null })
    const icon = root.querySelector('svg')
    expect(lucideName(icon)).toBe('message-circle-question-mark')
    expect(icon.classList).toContain('nc-state-dot__icon--question')
    expect(root.querySelector('[data-agent-spinner]')).toBeNull()
  })

  it('renders unverifiable as an amber dashed ring, never the done check or the spinner', () => {
    const root = render({ state: 'unverifiable', title: null })
    expect(lucideName(root.querySelector('svg'))).toBe('circle-dashed')
    expect(root.querySelector('.lucide-circle-check')).toBeNull()
    expect(root.querySelector('[data-agent-spinner]')).toBeNull()
  })

  it.each(['blocked', 'interrupted', 'failed'])('renders %s as a red attention dot', (state) => {
    const root = render({ state, title: null })
    expect(root.querySelector('.nc-state-dot__dot').classList).toContain('nc-state-dot__dot--alarm')
  })

  it('renders idle as a neutral dot', () => {
    const root = render({ state: 'idle', title: null })
    expect(root.querySelector('.nc-state-dot__dot').classList).not.toContain('nc-state-dot__dot--alarm')
  })

  it('carries a tooltip unless the caller suppresses it', () => {
    const withTooltip = render({ state: 'done' })
    // The tooltip trigger marks its element with data-state.
    expect(withTooltip.getAttribute('data-state')).toBe('closed')
    expect(withTooltip.getAttribute('aria-label')).toBe('Done')
    expect(withTooltip.hasAttribute('title')).toBe(false)
    wrapper.unmount()
    const suppressed = render({ state: 'interrupted', title: null })
    expect(suppressed.hasAttribute('data-state')).toBe(false)
    expect(suppressed.getAttribute('aria-label')).toBe('Interrupted')
  })
})
