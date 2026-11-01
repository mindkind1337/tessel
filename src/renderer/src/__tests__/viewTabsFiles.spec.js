// The line of tabs above the panes (ViewTabs.vue): Terminal first, then a tab
// per file each editor has open (a preview in italics, kept by a
// double-click), then each browser.
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { reactive } from 'vue'
import ViewTabs from '../components/ViewTabs.vue'
import { docs } from '../editor/documents'
import { pathKey } from '../editor/editorTabs'

const editor = {
  type: 'leaf',
  kind: 'editor',
  id: 'ed1',
  activePath: 'C:\\p\\b.js',
  files: [
    { path: 'C:\\p\\a.js', preview: true },
    { path: 'C:\\p\\b.js', preview: false }
  ]
}
const browser = { type: 'leaf', kind: 'browser', id: 'br1', url: 'https://example.com/', title: 'Example' }

describe('the line of tabs', () => {
  it('Terminal first, a tab per open file, then the browser', () => {
    const w = mount(ViewTabs, { props: { leaves: [editor, browser], shown: 'ed1' } })
    const tabs = w.findAll('[data-test="view-tab"]')
    expect(tabs.map((t) => t.find('.view-tab-label').text().trim())).toEqual(['Terminal', 'a.js', 'b.js', 'Example'])
    // The editor's current file is the active tab; the preview is in italics.
    expect(tabs[2].classes()).toContain('active')
    expect(tabs[1].classes()).not.toContain('active')
    expect(tabs[1].classes()).toContain('preview')
  })

  it("a file's tab has its own icon (the one of the explorer), an empty editor the code icon", () => {
    const img = { type: 'leaf', kind: 'editor', id: 'ed2', activePath: 'C:\p\Numérisation_1.png', files: [{ path: 'C:\p\Numérisation_1.png', preview: false }] }
    const w = mount(ViewTabs, { props: { leaves: [img, { type: 'leaf', kind: 'editor', id: 'ed3', files: [] }], shown: 'ed2' } })
    const tabs = w.findAll('[data-test="view-tab"]')
    // An image: Seti's picture glyph (U+E04C) in its purple, not the code brackets.
    const icon = tabs[1].find('[data-test="file-icon"]')
    expect(icon.exists()).toBe(true)
    expect(icon.text()).toBe(String.fromCodePoint(0xe04c))
    expect(tabs[1].find('svg.view-tab-icon').exists()).toBe(false)
    // No file open: the generic editor icon.
    expect(tabs[2].find('[data-test="file-icon"]').exists()).toBe(false)
    expect(tabs[2].find('svg.view-tab-icon').exists()).toBe(true)
  })
  it("a file's tab: shown, kept (double-click on a preview), closed in its editor", async () => {
    const w = mount(ViewTabs, { props: { leaves: [editor], shown: 'terminal' } })
    const a = w.findAll('[data-test="view-tab"]')[1]
    await a.trigger('click')
    expect(w.emitted('select').at(-1)).toEqual(['ed1', 'C:\\p\\a.js'])
    await a.trigger('dblclick')
    expect(w.emitted('keep').at(-1)).toEqual(['ed1', 'C:\\p\\a.js'])
    await a.find('[data-test="view-tab-close"]').trigger('click')
    expect(w.emitted('close').at(-1)).toEqual(['ed1', 'C:\\p\\a.js'])
    // A kept file: a double-click does nothing more.
    await w.findAll('[data-test="view-tab"]')[2].trigger('dblclick')
    expect(w.emitted('keep')).toHaveLength(1)
  })

  it("the editor's names: the folder for same-named files, what a diff shows; the unsaved dot", () => {
    const leaf = {
      ...editor,
      activePath: 'C:\\p\\x\\util.js',
      files: [
        { path: 'C:\\p\\x\\util.js' },
        { path: 'C:\\p\\y\\util.js' },
        { path: 'diff:C:\\p\\a.js', diff: { area: 'staged', full: 'C:\\p\\a.js' } }
      ]
    }
    docs[pathKey('C:\\p\\x\\util.js')] = { path: 'C:\\p\\x\\util.js', dirty: true }
    try {
      const w = mount(ViewTabs, { props: { leaves: [leaf], shown: 'ed1' } })
      const tabs = w.findAll('[data-test="view-tab"]')
      expect(tabs[1].text()).toContain('util.js · x')
      expect(tabs[2].text()).toContain('util.js · y')
      expect(tabs[3].text()).toContain('(staged diff)')
      expect(tabs[1].classes()).toContain('dirty')
      expect(tabs[1].find('.view-tab-dirty').exists()).toBe(true)
      expect(tabs[2].find('.view-tab-dirty').exists()).toBe(false)
      // Said to a screen reader too, by its close button.
      expect(tabs[1].find('[data-test="view-tab-close"]').attributes('aria-label')).toContain('unsaved changes')
    } finally {
      delete docs[pathKey('C:\\p\\x\\util.js')]
    }
  })

  it("an editor's or a browser's tab pulled moves that pane; the Terminal tab and an x don't", async () => {
    const w = mount(ViewTabs, { props: { leaves: [editor, browser], shown: 'ed1' } })
    const tabs = w.findAll('[data-test="view-tab"]')
    await tabs[3].trigger('pointerdown')
    expect(w.emitted('drag').at(-1)[0]).toBe('br1')
    await tabs[0].trigger('pointerdown')
    await tabs[1].find('[data-test="view-tab-close"]').trigger('pointerdown')
    expect(w.emitted('drag')).toHaveLength(1)
    // The line's free space: the pane it sits in.
    await w.find('[data-test="view-tabs"]').trigger('pointerdown')
    expect(w.emitted('drag').at(-1)[0]).toBeNull()
  })

  it("a browser making sound: a speaker on its tab mutes it, without showing or moving the tab", async () => {
    const page = reactive({ ...browser, audible: false, muted: false })
    const w = mount(ViewTabs, { props: { leaves: [page], shown: 'terminal' } })
    expect(w.find('[data-test="page-audio"]').exists()).toBe(false)
    page.audible = true
    await w.vm.$nextTick()
    const speaker = w.find('[data-test="view-tab"][data-tab="br1"] [data-test="page-audio"]')
    expect(speaker.exists()).toBe(true)
    await speaker.trigger('pointerdown')
    await speaker.trigger('click')
    expect(page.muted).toBe(true)
    expect(w.emitted('select')).toBeUndefined()
    expect(w.emitted('drag')).toBeUndefined()
    expect(w.find('[data-test="page-audio"]').attributes('aria-pressed')).toBe('true')
  })

  it('an editor with no file: one Editor tab', () => {
    const w = mount(ViewTabs, { props: { leaves: [{ ...editor, files: [], activePath: null }], shown: 'ed1' } })
    const tabs = w.findAll('[data-test="view-tab"]')
    expect(tabs.map((t) => t.text().trim())).toEqual(['Terminal', 'Editor'])
    expect(tabs[1].classes()).toContain('active')
  })
})
