// Commit hashes in agent text (links/commitRefs.js, CommitRef.vue): plain
// text until the message's repository says they are commits (asked on hover,
// never for every message shown), then links that open Source Control
// through the link router; a hash that is not a commit there stays text.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import ChatMarkdown from '../ChatMarkdown.vue'
import RichMessage from '../../../RichMessage.vue'
import { createLinkRouter, setLinkRouter } from '../../../../links/openTarget.js'
import { clearCommitCache, setCommitRoots } from '../../../../links/commitLinks.js'

const FULL = '1f6ccc70' + 'b'.repeat(32)
const context = { worktreeId: 'p1', worktreePath: 'C:\\proj', roots: ['C:\\proj'], runtimeEnvironmentId: null }

let wrapper = null
let prevApi
let router
beforeEach(() => {
  prevApi = window.shellApi
  window.shellApi = {
    scm: {
      resolveCommit: vi.fn(async ({ commit }) => (FULL.startsWith(commit) ? { ok: true, id: FULL, subject: 'Track commits', author: 'Ann', timestamp: Date.UTC(2026, 9, 1) } : { ok: false }))
    }
  }
  setCommitRoots([context.worktreePath])
  router = { openCommit: vi.fn(() => true), copyText: vi.fn(() => true), notOpened: vi.fn() }
  setLinkRouter(createLinkRouter(router))
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  window.shellApi = prevApi
  setLinkRouter(null)
  clearCommitCache()
  document.body.replaceChildren()
})

function render(props, component = ChatMarkdown) {
  wrapper = mount(component, { props, attachTo: document.body })
  return wrapper.element
}
const refs = (root) => [...root.querySelectorAll('[data-test="commit-ref"]')]
const hover = (el) => el.dispatchEvent(new window.MouseEvent('mouseenter'))
const click = (el, init = {}) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true, ...init }))

describe('commit hashes in ChatMarkdown', () => {
  it('asks only on hover, then links the ones that are commits', async () => {
    const root = render({ content: 'Pushed to GitHub (`1f6ccc70`), compare abc1234..def5678.', variant: 'document', fileLinkContext: context })
    const [inCode, a, b] = refs(root)
    expect(refs(root).map((r) => r.dataset.commit)).toEqual(['1f6ccc70', 'abc1234', 'def5678'])
    expect(inCode.closest('code')).not.toBeNull()
    expect(root.textContent).toContain('Pushed to GitHub (1f6ccc70), compare abc1234..def5678.')
    expect(window.shellApi.scm.resolveCommit).not.toHaveBeenCalled()
    expect(inCode.classList.contains('commit-ref-ok')).toBe(false)

    hover(inCode)
    await flushPromises()
    expect(window.shellApi.scm.resolveCommit).toHaveBeenCalledWith({ root: 'C:\\proj', commit: '1f6ccc70' })
    expect(inCode.classList.contains('commit-ref-ok')).toBe(true)
    expect(inCode.getAttribute('title')).toContain('1f6ccc7 Track commits')
    expect(inCode.getAttribute('role')).toBe('link')

    click(inCode)
    await flushPromises()
    expect(router.openCommit).toHaveBeenCalledWith({ root: 'C:\\proj', commit: FULL })
    click(inCode, { ctrlKey: true })
    await flushPromises()
    expect(router.copyText).toHaveBeenCalledWith(FULL)

    // Not a commit there: plain text, its click left to the surface.
    hover(a)
    await flushPromises()
    expect(a.classList.contains('commit-ref-ok')).toBe(false)
    expect(a.getAttribute('title')).toBeNull()
    click(a)
    await flushPromises()
    expect(router.openCommit).toHaveBeenCalledTimes(1)
    expect(b.classList.contains('commit-ref-ok')).toBe(false)
  })

  it('a click before any hover asks, then opens', async () => {
    const root = render({ content: 'see 1f6ccc70', fileLinkContext: context })
    click(refs(root)[0])
    await flushPromises()
    expect(router.openCommit).toHaveBeenCalledWith({ root: 'C:\\proj', commit: FULL })
  })

  it('no repository to ask (no context, a Live Share guest): text only', () => {
    const root = render({ content: 'Pushed (`1f6ccc70`)' })
    expect(refs(root)).toEqual([])
    expect(root.textContent).toContain('Pushed (1f6ccc70)')
    const guest = render({ text: 'Pushed (`1f6ccc70`)', context, guest: true }, RichMessage)
    expect(refs(guest)).toEqual([])
  })

  it("an author's own #tessel-commit- link is no commit link", () => {
    const root = render({ content: '[click me](#tessel-commit-1f6ccc70) and <a href="#tessel-commit-1f6ccc70" data-tessel-commit="1f6ccc70">x</a>', variant: 'document', fileLinkContext: context })
    expect(refs(root)).toEqual([])
  })

  it('a folder the window does not have open is never asked about', async () => {
    const root = render({ content: 'see 1f6ccc70', fileLinkContext: { ...context, worktreePath: 'D:\\other', roots: ['D:\\other'] } })
    hover(refs(root)[0])
    await flushPromises()
    expect(window.shellApi.scm.resolveCommit).not.toHaveBeenCalled()
    expect(refs(root)[0].classList.contains('commit-ref-ok')).toBe(false)
  })

  it('never inside a link or a code block', () => {
    const root = render({ content: '[release 1f6ccc70](https://example.com/x)\n\n```\n1f6ccc70\n```', variant: 'document', fileLinkContext: context })
    expect(refs(root)).toEqual([])
  })

  it("a task card's or the Conversations tab's message (RichMessage) reads its pane's repository", async () => {
    const root = render({ text: 'Merged as 1f6ccc70.', context }, RichMessage)
    const [ref] = refs(root)
    hover(ref)
    await flushPromises()
    expect(ref.classList.contains('commit-ref-ok')).toBe(true)
  })
})
