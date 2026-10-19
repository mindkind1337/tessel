// The Conversations tab read as the chat shows it (RichMessage.vue: Markdown,
// links through the link router, paths read against the pane that wrote
// them, a terminal line's images as thumbnails asked for by key), the type
// chips with their counts, combined with the search and the agent filter, the
// Media view and "Show in conversation"; a Live Share guest's: no path link,
// no image asked for, web links through the host's filter.
import { describe, it, expect, afterEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { nextTick } from 'vue'
import ConversationsPanel from '../components/ConversationsPanel.vue'
import { setLinkRouter } from '../links/openTarget'
import { clearPaneSessionTrail } from '../paneSessionTrail'
import { setSelectValue } from './selectTestUtils'

const NOW = new Date(2026, 9, 10, 15, 0, 0).getTime()
const MIN = 60 * 1000
const SID = '11111111-2222-4333-8444-555555555555'
const KEY = 'ab'.repeat(12)
const ada = { title: 'Ada', agentId: 'claude' }
const bob = { title: 'Bob', agentId: 'codex' }
const msg = (ago, paneId, agent, extra = {}) => ({ t: NOW - ago, type: 'message', paneId, agent, status: 'sent', source: 'you', scope: 'chat', wsId: 'ws1', ...extra })
const reply = (ago, paneId, agent, extra = {}) => ({ t: NOW - ago, type: 'reply', paneId, agent, kind: 'chat', wsId: 'ws1', ...extra })
const events = () => [
  msg(50 * MIN, 'p1', ada, { text: 'Please read the [design notes](https://docs.example.com/design) first' }),
  reply(49 * MIN, 'p1', ada, { text: 'Done. I changed `src/app.js` and wrote:\n\n```js\nexport const x = 1\n```\nDemo: https://youtu.be/abc123' }),
  msg(40 * MIN, 'p2', bob, { source: 'agent', from: 'Ada', fromPaneId: 'p1', scope: 'team-chat', status: 'read', teamId: 'team1', text: 'The build log is in C:\\proj\\logs\\ and the plan in C:\\proj\\docs\\plan.md' }),
  reply(30 * MIN, 'p2', bob, { teamId: 'team1', text: 'Thanks, nothing to add.' })
]
const projects = [
  {
    id: 'ws1',
    name: 'proj',
    cwd: 'C:\\proj',
    panes: [{ id: 'p1', kind: 'agent', agentId: 'claude', title: 'Ada', sessionId: SID }]
  }
]
const leaves = { p1: { id: 'p1', type: 'leaf', kind: 'agent', agentId: 'claude', cwd: 'C:\\proj', worktree: { path: 'C:\\proj-copies\\ada' } } }
const teams = [{ id: 'team1', name: 'Team 2' }]

function makeApi(extra = {}) {
  window.shellApi = {
    conversations: {
      terminal: vi.fn(async (q) => ({
        ok: true,
        panes: Object.fromEntries(
          q.panes
            .filter((p) => p.ask === 'p1')
            .map((p) => [p.ask, { key: 'k1', items: [{ role: 'user', t: NOW - 20 * MIN, text: 'What about this screen?', images: [{ key: KEY, name: 'screen.png', mime: 'image/png', bytes: 120, source: 'user' }], imagesMore: 1 }] }])
        )
      })),
      image: vi.fn(async () => ({ ok: true, dataUrl: 'data:image/png;base64,iVBORw0KGgo=' }))
    },
    chatFiles: { stat: vi.fn(async (paths) => Object.fromEntries(paths.map((p) => [p, 'file']))), open: vi.fn(async () => ({ ok: true })) },
    viewImage: vi.fn(async () => ({ ok: false })),
    ...extra
  }
}
function make(props = {}, panel = {}) {
  const ctx = {
    findLeaf: (id) => leaves[id] || null,
    paneFolder: (leaf) => leaf.cwd,
    viewFile: vi.fn(async () => true),
    openTarget: vi.fn(async () => true),
    openGuestUrl: vi.fn(),
    toast: vi.fn(),
    showImage: vi.fn(),
    ...panel
  }
  const w = mount(ConversationsPanel, {
    props: { events: events(), teams, projects, workspaceId: 'ws1', now: NOW, active: true, ...props },
    global: { provide: { panelCtx: ctx, askConfirm: async () => true } },
    attachTo: document.body
  })
  return { w, ctx }
}
const lineWith = (w, text) => w.findAll('[data-test="cv-line"]').find((l) => l.text().includes(text))
const chip = (w, type) => w.find(`[data-test="cv-type-${type}"]`)

afterEach(() => {
  document.body.innerHTML = ''
  delete window.shellApi
  setLinkRouter(null)
  clearPaneSessionTrail()
})

describe('ConversationsPanel.vue: rich messages, type chips, Media', () => {
  it('renders each message as Markdown: links, inline code, code blocks', async () => {
    makeApi()
    const { w } = make()
    await flushPromises()
    const done = lineWith(w, 'Done.')
    expect(done.find('pre').text()).toContain('export const x = 1')
    expect(done.find('code').exists()).toBe(true)
    const you = lineWith(w, 'design notes')
    const a = you.find('a')
    expect(a.text()).toBe('design notes')
    expect(a.attributes('href')).toBe('https://docs.example.com/design')
    w.unmount()
  })

  it('a web link opens through the link router, a path against the folder of the pane that wrote it (its worktree copy)', async () => {
    makeApi()
    const opened = []
    setLinkRouter({ open: async (target, opts) => (opened.push(target), true) })
    const { w, ctx } = make()
    await flushPromises()
    await lineWith(w, 'design notes').find('a').trigger('click')
    await flushPromises()
    expect(ctx.openTarget).toHaveBeenCalledWith('https://docs.example.com/design', expect.any(Object))
    // Ada's src/app.js: Ada's copy (C:\proj-copies\ada), not the project.
    const link = lineWith(w, 'Done.').findAll('a').find((x) => x.text().includes('src/app.js'))
    expect(link).toBeTruthy()
    await link.trigger('click')
    await flushPromises()
    expect(ctx.viewFile).toHaveBeenCalledTimes(1)
    expect(ctx.viewFile.mock.calls[0][0].file.replace(/\\/g, '/')).toBe('C:/proj-copies/ada/src/app.js')
    w.unmount()
  })

  it("a terminal line's images: thumbnails asked for by key, a lightbox on click, the ones not shown counted", async () => {
    makeApi()
    const opened = []
    setLinkRouter({ open: async (target) => (opened.push(target), true) })
    const { w } = make()
    await flushPromises()
    const line = lineWith(w, 'What about this screen?')
    const thumb = line.find('[data-test="message-thumb"]')
    expect(thumb.exists()).toBe(true)
    await flushPromises()
    expect(window.shellApi.conversations.image).toHaveBeenCalledWith(KEY)
    expect(line.find('img').attributes('src')).toBe('data:image/png;base64,iVBORw0KGgo=')
    expect(line.find('.rm-more').text()).toBe('+1')
    await thumb.trigger('click')
    expect(opened).toEqual([{ src: 'data:image/png;base64,iVBORw0KGgo=' }])
    w.unmount()
  })

  it('type chips: counts per type, any of the chosen, with the search and the agent filter', async () => {
    makeApi()
    const { w } = make()
    await flushPromises()
    const count = (type) => chip(w, type).find('.cv-type-count').text()
    expect(['link', 'image', 'video', 'file', 'folder', 'code'].map(count)).toEqual(['1', '1', '1', '2', '1', '1'])
    expect(chip(w, 'link').text()).toContain('Links')
    await chip(w, 'video').trigger('click')
    expect(chip(w, 'video').attributes('aria-pressed')).toBe('true')
    let lines = w.findAll('[data-test="cv-line"]')
    expect(lines).toHaveLength(1)
    expect(lines[0].text()).toContain('Demo:')
    await chip(w, 'folder').trigger('click')
    lines = w.findAll('[data-test="cv-line"]')
    expect(lines.map((l) => (l.text().includes('Demo:') ? 'demo' : l.text().includes('build log') ? 'log' : 'other'))).toEqual(['demo', 'log'])
    // With the search: only what matches both.
    await w.find('[data-test="cv-search"]').setValue('build')
    expect(w.findAll('[data-test="cv-line"]')).toHaveLength(1)
    // The counts follow the other filters.
    expect(count('video')).toBe('0')
    await w.find('[data-test="cv-search"]').setValue('')
    await setSelectValue(w.find('[data-test="cv-participant"]'), 'Bob')
    expect(w.findAll('[data-test="cv-line"]').map((l) => l.text().includes('build log'))).toEqual([true])
    await setSelectValue(w.find('[data-test="cv-participant"]'), '')
    await chip(w, 'video').trigger('click')
    await chip(w, 'folder').trigger('click')
    expect(w.findAll('[data-test="cv-line"]').length).toBeGreaterThan(3)
    w.unmount()
  })

  it('the Media view lists what is shared (who, when), opens it, and goes back to its message', async () => {
    makeApi()
    const { w, ctx } = make()
    await flushPromises()
    await w.find('[data-test="cv-view-media"]').trigger('click')
    expect(w.find('[data-test="cv-media"]').exists()).toBe(true)
    expect(w.find('[data-test="cv-count"]').text()).toContain('shared items')
    expect(w.find('[data-test="cv-media-visual"]').exists()).toBe(true)
    expect(w.find('[data-test="cv-media-link"]').text()).toContain('design notes')
    expect(w.find('[data-test="cv-media-link"]').text()).toContain('docs.example.com')
    expect(w.find('[data-test="cv-media-path"]').text()).toContain('plan.md')
    expect(w.find('[data-test="cv-media-code"]').text()).toContain('export const x = 1')
    // Who shared it.
    expect(w.find('[data-test="cv-media-link"]').text()).toContain('You')
    // A link opens through the router.
    await w.find('[data-test="cv-media-link"] .cm-row-main').trigger('click')
    expect(ctx.openTarget).toHaveBeenCalledWith('https://docs.example.com/design', expect.any(Object))
    // A type chip narrows the Media view too.
    await chip(w, 'code').trigger('click')
    expect(w.findAll('[data-test="cv-media-item"]')).toHaveLength(1)
    // Back to the message.
    Element.prototype.scrollIntoView = vi.fn()
    await w.find('[data-test="cv-media-jump"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="cv-media"]').exists()).toBe(false)
    const flashed = w.find('.cv-line.flash')
    expect(flashed.exists()).toBe(true)
    expect(flashed.text()).toContain('export const x = 1')
    expect(Element.prototype.scrollIntoView).toHaveBeenCalled()
    w.unmount()
  })

  it('an agent on a host not connected: said under the counts, never a silent gap', async () => {
    makeApi()
    window.shellApi.conversations.terminal = vi.fn(async (q) => ({ ok: true, panes: {}, waiting: Object.fromEntries(q.panes.filter((p) => p.hostId).map((p) => [p.ask, 'offline'])) }))
    const remoteProjects = [...projects, { id: 'ws9', name: 'esx', remote: { host: 'esx-box' }, panes: [{ id: 'r1', kind: 'agent', agentId: 'claude', title: 'Archimedes', sessionId: SID.replace('1111', '9999'), remoteHostId: 'ssh-esx' }] }]
    const { w } = make({ projects: remoteProjects })
    await w.find('[data-test="cv-scope-all"]').trigger('click')
    await flushPromises()
    expect(w.find('[data-test="cv-waiting"]').text()).toBe('Not read: Archimedes (their host esx-box is not connected)')
    w.unmount()
  })

  it("a Live Share guest's: no path is a link, no image is asked for, a web link goes through the host's filter", async () => {
    makeApi()
    const source = {
      project: 'proj',
      host: 'Ada (host)',
      events: events(),
      teams,
      follow: vi.fn(),
      terminal: vi.fn(async () => ({ ok: true, panes: {} }))
    }
    const { w, ctx } = make({ source })
    await flushPromises()
    const done = lineWith(w, 'Done.')
    expect(done.findAll('a').some((a) => a.text().includes('src/app.js'))).toBe(false)
    expect(lineWith(w, 'build log').findAll('a')).toHaveLength(0)
    await lineWith(w, 'design notes').find('a').trigger('click')
    expect(ctx.openGuestUrl).toHaveBeenCalledWith('https://docs.example.com/design', {})
    expect(ctx.openTarget).not.toHaveBeenCalled()
    expect(window.shellApi.conversations.image).not.toHaveBeenCalled()
    w.unmount()
  })
})
