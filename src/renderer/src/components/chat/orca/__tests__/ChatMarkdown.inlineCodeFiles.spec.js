// Tessel: inline code naming a file that exists becomes a link (ChatMarkdown
// + chat-inline-code-files.js). The main process's stat is mocked.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import { routeNativeChatHref } from '../../../../chat/orca/shared/native-chat-href-routing.js'
import ChatMarkdown from '../ChatMarkdown.vue'
import {
  clearInlineCodeFileCache,
  looksLikeFileName,
  MAX_STAT_PER_MESSAGE,
  resolveInlineCodeFiles
} from '../chat-inline-code-files.js'
import { parseSanitizedHtml } from '../chat-markdown-render.js'

let wrapper = null
let disk = {}
let stat
function render(content, context = { worktreePath: 'C:/repo', roots: ['C:/repo'] }, extra = {}) {
  wrapper = mount(ChatMarkdown, {
    props: { content, variant: 'document', linkifyFilePaths: true, onLinkClick: vi.fn(), ...extra },
    global: { provide: { nativeChatFileLinkContext: context } },
    attachTo: document.body
  })
  return wrapper
}
const hrefPath = (a) => routeNativeChatHref(a.getAttribute('href')).pathText
const codeLinks = (w) => Array.from(w.element.querySelectorAll('a.cm-code-link'))

beforeEach(() => {
  clearInlineCodeFileCache()
  disk = {}
  stat = vi.fn(async (paths) => Object.fromEntries(paths.map((p) => [p, disk[p] ?? null])))
  window.shellApi = { chatFiles: { stat, open: vi.fn() } }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.shellApi
  document.body.replaceChildren()
})

describe('looksLikeFileName', () => {
  it.each(['tessel-logo.mp4', 'README.md', 'src/main/index.js', 'C:\\x\\y.gif', 'src/main/', 'my_file-2.PNG'])(
    '%s looks like a file',
    (v) => expect(looksLikeFileName(v)).toBe(true)
  )
  it.each(['npm', 'useState', 'true', '1.2.3', 'fn(a.b)', 'a = b.c', 'https://x.io/a.png', '--flag.x', '...', '\\\\server\\s\\a.png', ''])(
    '%s does not',
    (v) => expect(looksLikeFileName(v)).toBe(false)
  )
})

describe('inline code file links', () => {
  it('links a bare name found in a folder the same message mentions', async () => {
    disk['C:/Users/me/Documents/tessel-icons/video/tessel-logo.mp4'] = 'file'
    const w = render(
      'The videos are in C:\\Users\\me\\Documents\\tessel-icons\\video\\ now.\n\nOpen `tessel-logo.mp4` to check.'
    )
    await flushPromises()
    const links = codeLinks(w)
    expect(links).toHaveLength(1)
    expect(links[0].textContent).toBe('tessel-logo.mp4')
    expect(hrefPath(links[0])).toBe('C:/Users/me/Documents/tessel-icons/video/tessel-logo.mp4')
    expect(stat).toHaveBeenCalledTimes(1)
    // The chat's folder first, then the mentioned one.
    expect(stat.mock.calls[0][0]).toEqual(['C:/repo/tessel-logo.mp4', 'C:/Users/me/Documents/tessel-icons/video/tessel-logo.mp4'])
  })

  it('links a name found in the chat folders, and the click goes to the link handler', async () => {
    disk['C:/repo/package.json'] = 'file'
    const onLinkClick = vi.fn()
    const w = render('See `package.json`.', undefined, { onLinkClick })
    await flushPromises()
    const [link] = codeLinks(w)
    expect(hrefPath(link)).toBe('C:/repo/package.json')
    link.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }))
    expect(onLinkClick).toHaveBeenCalledWith(expect.anything(), link.getAttribute('href'))
  })

  it('never links plain words, and never asks about them', async () => {
    const w = render('Run `npm` with `useState` and `true`, then `fn(a.b)`.')
    await flushPromises()
    expect(w.element.querySelectorAll('a')).toHaveLength(0)
    expect(stat).not.toHaveBeenCalled()
  })

  it('does not link a name that does not exist', async () => {
    const w = render('Maybe `ghost.gif` or `console.log`.')
    await flushPromises()
    expect(stat).toHaveBeenCalledTimes(1)
    expect(w.element.querySelectorAll('a')).toHaveLength(0)
  })

  it('looks once per message (cached), in one bounded batch', async () => {
    const many = Array.from({ length: 100 }, (_, i) => `\`f${i}.png\``).join(' ')
    render(many)
    await flushPromises()
    wrapper.unmount()
    render(many)
    await flushPromises()
    expect(stat).toHaveBeenCalledTimes(1)
    expect(stat.mock.calls[0][0].length).toBeLessThanOrEqual(MAX_STAT_PER_MESSAGE)
  })

  it('does nothing without a chat context, for remote chats, or when links are off', async () => {
    render('`a.png`', null)
    await flushPromises()
    wrapper.unmount()
    render('`a.png`', { worktreePath: 'C:/repo', remote: { hostId: 'h' } })
    await flushPromises()
    wrapper.unmount()
    render('`a.png`', undefined, { linkifyFilePaths: false })
    await flushPromises()
    expect(stat).not.toHaveBeenCalled()
  })

  it('never looks at a network path, even one the message mentions', async () => {
    const fragment = parseSanitizedHtml('<p>In \\\\server\\share\\video\\ there is <code>x.mp4</code></p>')
    await resolveInlineCodeFiles({
      fragment,
      content: 'In \\\\server\\share\\video\\ there is `x.mp4`',
      context: { worktreePath: 'C:/repo', roots: ['C:/repo'] },
      stat
    })
    expect(stat.mock.calls[0][0]).toEqual(['C:/repo/x.mp4'])
  })
})
