// Tessel: file paths in the plain text of a message (the user's, a teammate's,
// the agent's) are links when the file exists. The main process's stat is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { routeNativeChatHref } from '../../../../chat/orca/shared/native-chat-href-routing.js'

vi.mock('../NativeChatToolRun.vue', async () => {
  const { defineComponent, h } = await import('vue')
  return { default: defineComponent({ name: 'ToolRunStub', setup: () => () => h('div') }) }
})

import ChatMarkdown from '../ChatMarkdown.vue'
import NativeChatMessageRow from '../NativeChatMessageRow.vue'
import { clearInlineCodeFileCache } from '../chat-inline-code-files.js'

const PASTE = 'C:\\Users\\jeanc\\AppData\\Local\\Temp\\tessel-paste\\image-1790815616156.png'
const PASTE_ABS = 'C:/Users/jeanc/AppData/Local/Temp/tessel-paste/image-1790815616156.png'
const CONTEXT = { worktreePath: 'C:/repo', roots: ['C:/repo'] }

let wrapper = null
let disk = {}
let stat
const links = () => Array.from(wrapper.element.querySelectorAll('a'))
const pathOf = (a) => routeNativeChatHref(a.getAttribute('href')).pathText

function renderMd(content, props = {}) {
  wrapper = mount(ChatMarkdown, {
    props: { content, variant: 'document', linkifyExistingPaths: true, onLinkClick: vi.fn(), ...props },
    global: { provide: { nativeChatFileLinkContext: CONTEXT } },
    attachTo: document.body
  })
  return wrapper
}

function renderRow(message, onLinkClick = vi.fn()) {
  wrapper = mount(NativeChatMessageRow, {
    props: { message: { id: 'm', timestamp: 0, source: 'transcript', ...message }, expandSignal: false, onLinkClick },
    global: { provide: { nativeChatFileLinkContext: CONTEXT }, stubs: { transition: false } },
    attachTo: document.body
  })
  return wrapper
}

beforeEach(() => {
  clearInlineCodeFileCache()
  disk = { [PASTE_ABS]: 'file', 'C:/x/y.gif': 'file', 'C:/repo/src/main/index.js': 'file', 'C:/My Folder/a.png': 'file' }
  stat = vi.fn(async (paths) => Object.fromEntries(paths.map((p) => [p, disk[p] ?? null])))
  window.shellApi = { writeClipboard: vi.fn(), chatFiles: { stat, open: vi.fn() } }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.shellApi
  document.body.replaceChildren()
})

describe('plain-text paths in message bodies', () => {
  it("a teammate's message: existing absolute paths become links", async () => {
    const onLinkClick = vi.fn()
    renderRow(
      {
        role: 'user',
        sentAs: 'team',
        from: 'Darwin',
        blocks: [{ type: 'text', text: `Voici la capture : ${PASTE} et aussi C:/x/y.gif, puis C:\\x\\gone.png.` }]
      },
      onLinkClick
    )
    // Nothing is a link before main has answered.
    expect(links()).toHaveLength(0)
    await flushPromises()
    expect(links().map(pathOf)).toEqual([PASTE_ABS, 'C:/x/y.gif'])
    expect(links()[0].textContent).toBe(PASTE)
    expect(wrapper.text()).toContain('C:\\x\\gone.png.')
    links()[0].dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), links()[0].getAttribute('href'))
  })

  it("the user's own message too, with a relative path found in the chat folder", async () => {
    renderRow({ role: 'user', blocks: [{ type: 'text', text: 'Look at src/main/index.js:12 please' }] })
    await flushPromises()
    expect(links().map(pathOf)).toEqual(['C:/repo/src/main/index.js:12'])
  })

  it("the agent's message links paths in its prose", async () => {
    renderRow({ role: 'assistant', blocks: [{ type: 'text', text: `Saved to ${PASTE}.` }] })
    await flushPromises()
    expect(links()).toHaveLength(1)
    expect(routeNativeChatHref(links()[0].getAttribute('href')).pathText.replace(/\\/g, '/')).toBe(PASTE_ABS)
  })

  it('leaves out trailing punctuation', async () => {
    renderMd('(see C:\\x\\y.gif). Done')
    await flushPromises()
    expect(links().map((a) => a.textContent)).toEqual(['C:\\x\\y.gif'])
    expect(wrapper.text()).toContain('(see C:\\x\\y.gif). Done')
  })

  it('never links URLs nor paths in code blocks', async () => {
    renderMd('Get https://example.com/a/b.png now.\n\n```\nC:\\x\\y.gif\n```')
    await flushPromises()
    // markdown-it's own web link stays; no file link.
    expect(links().map((a) => routeNativeChatHref(a.getAttribute('href')).kind)).toEqual(['web'])
    expect(stat).not.toHaveBeenCalled()
  })

  it('a path with spaces only when quoted or in backticks', async () => {
    renderMd('Unquoted C:\\My Folder\\a.png here.')
    await flushPromises()
    expect(links().map(pathOf)).not.toContain('C:/My Folder/a.png')
    wrapper.unmount()
    clearInlineCodeFileCache()
    renderMd('Quoted "C:\\My Folder\\a.png" and `C:\\My Folder\\a.png`')
    await flushPromises()
    expect(links().map(pathOf)).toEqual(['C:/My Folder/a.png', 'C:/My Folder/a.png'])
  })

  it('never links nor looks at a program or a network path', async () => {
    renderMd('Run C:\\x\\setup.exe or open \\\\server\\share\\a.png')
    await flushPromises()
    expect(links()).toHaveLength(0)
    expect(stat).not.toHaveBeenCalled()
  })

  it('keeps explicit Markdown links as written', async () => {
    renderMd('[site](https://example.com) and C:\\x\\gone.png')
    await flushPromises()
    expect(links().map((a) => a.getAttribute('href'))).toEqual(['https://example.com'])
  })

  it('looks once per message', async () => {
    renderMd(`One ${PASTE}`)
    await flushPromises()
    wrapper.unmount()
    renderMd(`One ${PASTE}`)
    await flushPromises()
    expect(stat).toHaveBeenCalledTimes(1)
    expect(links()).toHaveLength(1)
  })

  it('without the stat call (no Tessel main process) nothing is linked', async () => {
    window.shellApi = { writeClipboard: vi.fn() }
    renderMd(`One ${PASTE}`)
    await flushPromises()
    expect(links()).toHaveLength(0)
  })
})
