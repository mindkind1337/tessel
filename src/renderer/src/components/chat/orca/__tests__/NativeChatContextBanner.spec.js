// Tessel's low-context banner, and the words of a model or effort change.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import NativeChatContextBanner from '../NativeChatContextBanner.vue'
import { setMessages } from '../../../../i18n/index.js'
import fr from '../../../../i18n/locales/fr/chat.json'
import { chatOptionNoticeText } from '../../../../chat/orca/chat-option-notice.js'

let wrapper = null
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  setMessages('en', {})
})

const usage = (percentage) => ({ usedTokens: percentage * 2000, windowTokens: 200000, percentage, estimated: true, categories: [] })
function render(props) {
  wrapper = mount(NativeChatContextBanner, { props: { agentName: 'Codex', ...props } })
  return wrapper
}
const banner = () => wrapper.find('[data-test="chat-context-low"]')
const compactButton = () => wrapper.find('[data-test="chat-context-compact"]')

describe('NativeChatContextBanner', () => {
  it('shows from 85 % with a Compact button that compacts once', async () => {
    const compact = vi.fn(async () => ({ ok: true }))
    render({ usage: usage(84), compact })
    expect(banner().exists()).toBe(false)
    await wrapper.setProps({ usage: usage(87) })
    expect(banner().text()).toContain('87% full (174k / 200k)')
    await compactButton().trigger('click')
    await flushPromises()
    expect(compact).toHaveBeenCalledTimes(1)
    expect(compactButton().text()).toBe('Compacting…')
    expect(compactButton().attributes('disabled')).toBeDefined()
    // The compaction landed: the usage is unknown, the banner goes.
    await wrapper.setProps({ usage: null })
    expect(banner().exists()).toBe(false)
  })

  it('waits for the end of the turn; a refused compaction offers the button again', async () => {
    const compact = vi.fn(async () => ({ ok: false, error: 'nope' }))
    render({ usage: usage(90), compact, busy: true })
    expect(compactButton().attributes('disabled')).toBeDefined()
    await wrapper.setProps({ busy: false })
    await compactButton().trigger('click')
    await flushPromises()
    expect(compact).toHaveBeenCalledTimes(1)
    expect(compactButton().attributes('disabled')).toBeUndefined()
  })

  it('without a compact action it only warns; closed, it stays closed until the context is low again', async () => {
    render({ usage: usage(95), compact: null })
    expect(compactButton().exists()).toBe(false)
    expect(banner().text()).toContain('Codex cannot compact it here')
    await wrapper.find('[data-test="chat-context-dismiss"]').trigger('click')
    expect(banner().exists()).toBe(false)
    await wrapper.setProps({ usage: usage(96) })
    expect(banner().exists()).toBe(false)
    await wrapper.setProps({ usage: usage(20) })
    await wrapper.setProps({ usage: usage(90) })
    expect(banner().exists()).toBe(true)
  })

  it('speaks French: Compacter', () => {
    setMessages('fr', fr)
    render({ usage: usage(88), compact: vi.fn() })
    expect(compactButton().text()).toBe('Compacter')
    expect(banner().text()).toContain('Contexte rempli à 88 %')
  })
})

describe('chatOptionNoticeText', () => {
  it('words a change like the composer pills, in English and French', () => {
    expect(chatOptionNoticeText({ option: 'model', value: 'claude-opus-5-5', ok: true }, 'claude')).toBe('Model: Opus 5.5')
    expect(chatOptionNoticeText({ option: 'effort', value: 'xhigh', ok: true }, 'claude')).toBe('Effort: Extra high')
    expect(chatOptionNoticeText({ option: 'effort', value: 'high', ok: false }, 'claude')).toBe('Effort not changed: High')
    expect(chatOptionNoticeText({ option: 'effort', value: 'high', ok: true, from: 'medium' }, 'claude')).toBe('Effort: Medium → High')
    expect(chatOptionNoticeText({ option: 'model', value: 'claude-opus-5-5', ok: true, from: 'claude-opus-5-5' }, 'claude')).toBe('Model: Opus 5.5')
    setMessages('fr', fr)
    expect(chatOptionNoticeText({ option: 'model', value: 'claude-opus-5-5', ok: true }, 'claude')).toBe('Modèle : Opus 5.5')
    expect(chatOptionNoticeText({ option: 'effort', value: 'high', ok: true }, 'claude')).toBe(`Effort : ${fr['chat.orca.composer.optionValue.high'] || 'Élevé'}`)
    expect(chatOptionNoticeText({ option: 'model', value: 'x-model', ok: false }, 'codex')).toBe('Modèle non changé : x-model')
    expect(chatOptionNoticeText({ option: 'permissionMode', value: 'plan' }, 'claude')).toBe('')
  })
})
