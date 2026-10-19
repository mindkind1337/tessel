// Tessel: clickable agent edits. A file tool's path opens its file at the line
// it read or first changed (the link router), an edit opens its diff in an
// editor tab, Codex's relative patch paths open in the turn's own folder, and
// a turn's changed files can be opened, diffed and reviewed.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { computed } from 'vue'
import NativeChatToolLine from '../NativeChatToolLine.vue'
import NativeChatDiffCard from '../NativeChatDiffCard.vue'
import NativeChatChangedFiles from '../NativeChatChangedFiles.vue'
import { buildEditCards, buildEditSummaries } from '../../../../chat/orca/native-chat-edit-cards.js'
import { turnChangedFiles } from '../../../../chat/agentEdits.js'

let wrapper = null
let panel
const files = new Map()

beforeEach(() => {
  panel = {
    openTarget: vi.fn(async () => true),
    openAgentDiff: vi.fn(() => ({})),
    reviewPaneChanges: vi.fn(() => true),
    toast: vi.fn()
  }
  files.clear()
  window.shellApi = {
    editor: {
      read: vi.fn(async (file) => (files.has(file) ? { ok: true, text: files.get(file) } : { ok: false, error: 'missing' })),
      head: vi.fn(async () => ({ ok: true, text: 'committed\n' }))
    }
  }
})
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  delete window.shellApi
  document.body.innerHTML = ''
})

const LOCAL = { worktreeId: 'pane-1', worktreePath: 'C:\\proj', roots: ['C:\\proj'], runtimeEnvironmentId: null }

function render(component, props, context = LOCAL) {
  wrapper = mount(component, {
    props,
    attachTo: document.body,
    global: { provide: { panelCtx: panel, nativeChatFileLinkContext: computed(() => context) } }
  })
  return wrapper
}

const call = (name, input, extra = {}) => ({ type: 'tool-call', name, input, state: 'completed', callId: `c-${name}`, ...extra })

describe('tool line header', () => {
  it("opens a Read's file at the line it starts reading", async () => {
    const w = render(NativeChatToolLine, { block: call('Read', { file_path: 'src/a.js', offset: 42 }, { folder: 'C:\\proj' }), initiallyExpanded: false })
    await w.find('[data-test="tool-path-link"]').trigger('click')
    await flushPromises()
    expect(panel.openTarget).toHaveBeenCalledWith({ path: 'C:\\proj\\src\\a.js', line: 42 }, expect.anything())
    // The row did not fold or unfold for it.
    expect(w.find('.nc-tool-line').attributes('aria-expanded')).not.toBe('true')
  })

  it("finds an edit's first changed line in the file when the agent did not record it, and opens its diff", async () => {
    files.set('C:\\proj\\src\\b.js', 'one\ntwo\nTHREE\nfour\n')
    const block = call('replace', { file_path: 'C:\\proj\\src\\b.js', old_string: 'three', new_string: 'THREE' })
    const w = render(NativeChatToolLine, { block, result: { type: 'tool-result', output: 'ok' }, initiallyExpanded: false })
    await w.find('[data-test="tool-open-file"]').trigger('click')
    await flushPromises()
    expect(panel.openTarget).toHaveBeenCalledWith({ path: 'C:\\proj\\src\\b.js', line: 3 }, expect.anything())
    await w.find('[data-test="tool-open-diff"]').trigger('click')
    await flushPromises()
    expect(panel.openAgentDiff).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'C:\\proj\\src\\b.js', original: 'one\ntwo\nthree\nfour\n', modified: 'one\ntwo\nTHREE\nfour\n', snippet: false, line: 3 })
    )
  })

  it("keeps a conversation from elsewhere's paths as plain text", () => {
    const w = render(NativeChatToolLine, { block: call('Read', { file_path: 'C:\\host\\a.js' }), initiallyExpanded: false }, null)
    expect(w.find('[data-test="tool-path-link"]').exists()).toBe(false)
    expect(w.find('[data-test="tool-open-file"]').exists()).toBe(false)
  })
})

describe('diff card', () => {
  it("opens a Codex patch's relative path in the turn's folder at its first change", async () => {
    const patch = '*** Begin Patch\n*** Update File: src/app.js\n@@\n keep\n-old\n+new\n*** End Patch'
    const block = call('apply_patch', patch, { cwd: 'C:\\proj.worktrees\\t1' })
    const [edit] = buildEditCards([block]).editCards.values()
    files.set('C:\\proj.worktrees\\t1\\src\\app.js', 'head\nkeep\nnew\ntail\n')
    const w = render(NativeChatDiffCard, { file: edit.files[0], call: block })
    await w.find('[data-test="diff-card-path"]').trigger('click')
    await flushPromises()
    expect(panel.openTarget).toHaveBeenCalledWith({ path: 'C:\\proj.worktrees\\t1\\src\\app.js', line: 3 }, expect.anything())
    await w.find('[data-test="diff-card-open-diff"]').trigger('click')
    await flushPromises()
    expect(panel.openAgentDiff).toHaveBeenCalledWith(
      expect.objectContaining({ file: 'C:\\proj.worktrees\\t1\\src\\app.js', original: 'head\nkeep\nold\ntail\n', modified: 'head\nkeep\nnew\ntail\n', snippet: false })
    )
  })

  it("falls back to the edit's own snippets when the file changed since", async () => {
    const block = call('Edit', { file_path: 'C:\\proj\\c.js', old_string: 'a = 1', new_string: 'a = 2' })
    const [edit] = buildEditCards([block]).editCards.values()
    files.set('C:\\proj\\c.js', 'a = 5\n')
    const w = render(NativeChatDiffCard, { file: edit.files[0], call: block })
    await w.find('[data-test="diff-card-open-diff"]').trigger('click')
    await flushPromises()
    expect(panel.openAgentDiff).toHaveBeenCalledWith(expect.objectContaining({ original: 'a = 1', modified: 'a = 2', snippet: true, line: null }))
  })

  it('without the call, stays as it was (no link, no diff button)', () => {
    const block = call('Edit', { file_path: 'C:\\proj\\c.js', old_string: 'a', new_string: 'b' })
    const [edit] = buildEditCards([block]).editCards.values()
    const w = render(NativeChatDiffCard, { file: edit.files[0] })
    expect(w.find('[data-test="diff-card-path"]').exists()).toBe(false)
    expect(w.find('[data-test="diff-card-open-diff"]').exists()).toBe(false)
  })
})

describe('changed files strip', () => {
  function changes() {
    const messages = [
      { id: 'u1', role: 'user', blocks: [{ type: 'text', text: 'go' }] },
      {
        id: 'a1',
        role: 'assistant',
        blocks: [
          call('Edit', { file_path: 'C:\\proj\\src\\a.js', old_string: 'x', new_string: 'y' }, { editLine: 7 }),
          { type: 'tool-result', output: 'ok' },
          call('Write', { file_path: 'C:\\proj\\new.md', content: '# hi\n' }, { callId: 'w1' }),
          { type: 'tool-result', output: 'File created successfully at: C:\\proj\\new.md' }
        ]
      }
    ]
    return turnChangedFiles(messages, ['u1', 'u1'], buildEditSummaries).get('u1')
  }

  it('lists each file with its counts; a file opens at its first change, its diff opens in a tab', async () => {
    files.set('C:\\proj\\new.md', '# hi\n')
    const w = render(NativeChatChangedFiles, { changes: changes() })
    expect(w.text()).toContain('2 files changed')
    const opens = w.findAll('[data-test="changed-file-open"]')
    expect(opens.map((b) => b.find('.nc-changed-files__name').text())).toEqual(['a.js', 'new.md'])
    expect(opens.map((b) => b.find('.nc-changed-files__folder').text())).toEqual(['C:/proj/src', 'C:/proj'])
    await opens[0].trigger('click')
    await flushPromises()
    expect(panel.openTarget).toHaveBeenCalledWith({ path: 'C:\\proj\\src\\a.js', line: 7 }, expect.anything())
    await w.findAll('[data-test="changed-file-diff"]')[1].trigger('click')
    await flushPromises()
    expect(panel.openAgentDiff).toHaveBeenCalledWith(expect.objectContaining({ file: 'C:\\proj\\new.md', original: '', modified: '# hi\n' }))
  })

  it("Review all opens the pane's changes", async () => {
    const w = render(NativeChatChangedFiles, { changes: changes() })
    await w.find('[data-test="changed-files-review"]').trigger('click')
    expect(panel.reviewPaneChanges).toHaveBeenCalledWith('pane-1')
  })

  it('a guest sees the list but nothing to open', () => {
    const w = render(NativeChatChangedFiles, { changes: changes() }, null)
    expect(w.text()).toContain('2 files changed')
    expect(w.find('[data-test="changed-file-open"]').exists()).toBe(false)
    expect(w.find('[data-test="changed-files-review"]').exists()).toBe(false)
  })
})
