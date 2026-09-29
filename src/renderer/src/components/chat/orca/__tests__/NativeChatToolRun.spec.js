// After Orca's NativeChatToolRun.test.tsx (MIT, Copyright (c) 2026 Lovecast Inc.),
// plus Tessel's protections: secrets masked before any label is cut, a stopped
// call says "Stopped" and is never marked done.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { mount } from '@vue/test-utils'
import { nextTick } from 'vue'
import NativeChatToolRun from '../NativeChatToolRun.vue'
import { projectStructuredItemToNativeChat } from '../../../../chat/orca/shared/structured-agent-session-projection.js'
import {
  allByText,
  buttonNamed,
  byText,
  byTitle,
  clickEvent,
  leadingGlyphs,
  lucideName,
  queryByText,
  queryByTitle
} from './native-chat-tool-test-dom.js'

let wrapper = null
let prevShellApi
afterEach(() => {
  wrapper?.unmount()
  wrapper = null
  document.body.innerHTML = ''
  if (prevShellApi !== undefined) window.shellApi = prevShellApi
  prevShellApi = undefined
})

function render(props) {
  const container = document.createElement('div')
  document.body.appendChild(container)
  wrapper = mount(NativeChatToolRun, { props, attachTo: container })
  return {
    container,
    rerender: async (next) => {
      await wrapper.setProps(next)
      await nextTick()
    }
  }
}

/** The run header — the first button in a run, above its member rows. */
function runHeader(container) {
  const header = container.querySelector('button')
  if (!header) throw new Error('run header did not render')
  return header
}

async function click(element) {
  clickEvent(element)
  await nextTick()
}

describe('NativeChatToolRun', () => {
  it('uses the shared clean label for a desktop tool row', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'Read', input: '{"file_path":"src/index.ts","offset":10}' }],
      expandSignal: true
    })

    expect(byTitle(container, 'src/index.ts').textContent).toContain('src/index.ts')
    expect(queryByTitle(container, '{"file_path":"src/index.ts","offset":10}')).toBeNull()
  })

  it('renders structured apply_patch changes as a reviewable diff instead of JSON', () => {
    const { container } = render({
      blocks: [
        {
          type: 'tool-call',
          name: 'apply_patch',
          // The patch lives on the call in this lane, so the provider's own
          // completion is what says the edit landed.
          state: 'completed',
          input: {
            changes: [
              {
                path: '/repo/src/app.ts',
                kind: { type: 'update', move_path: null },
                diff: '@@ -1 +1 @@\n-before\n+after'
              }
            ]
          }
        }
      ],
      expandSignal: true
    })

    expect(queryByText(container, 'after')).not.toBeNull()
    expect(queryByText(container, 'before')).not.toBeNull()
    expect(queryByText(container, 'Edited file')).not.toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('renders evidence-shaped projected patches as colored diffs without changes JSON', () => {
    const projected = projectStructuredItemToNativeChat({
      itemId: 'apply-patch',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'tool-call',
        name: 'apply_patch',
        input: { changes: [{ path: 'src/app.ts', diff: '@@ -1 +1 @@\n-before\n+after' }] },
        state: 'completed'
      }
    })

    expect(projected).not.toBeNull()
    const { container } = render({ blocks: projected?.blocks ?? [], expandSignal: true })

    // Row grounds come from the diff tokens, not a hardcoded palette value.
    expect(byText(container, 'after').closest('div').classList).toContain('nc-diff-card__row--add')
    expect(byText(container, 'before').closest('div').classList).toContain('nc-diff-card__row--del')
    expect(container.textContent).not.toContain('"changes"')
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps the provider error visible for an edit the agent could not apply', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'missing', new_string: 'now' } },
        { type: 'tool-result', output: 'String to replace not found in file.', isError: true }
      ],
      expandSignal: true
    })

    expect(queryByText(container, 'Edited file')).toBeNull()
    const body = container.querySelector('pre')
    expect(body.textContent).toContain('String to replace not found in file.')
    expect(body.classList).toContain('nc-tool-line__pre--error')
  })

  it('leaves a `git diff` command as a command row rather than an edit card', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'exec', input: { command: 'git diff' }, state: 'completed' },
        { type: 'tool-result', output: 'diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-was\n+now' }
      ],
      expandSignal: true
    })

    expect(queryByText(container, 'Edited file')).toBeNull()
    expect(container.textContent).toContain('git diff')
  })

  it('shows no gutter number for a snippet edit, which cannot locate itself', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Edit', input: { file_path: '/repo/a.ts', old_string: 'was', new_string: 'now' }, state: 'completed' },
        { type: 'tool-result', output: 'ok' }
      ],
      expandSignal: true
    })

    // Exact, because a snippet-relative number would sit ahead of the marker.
    expect(byText(container, 'now').closest('div').textContent).toBe('+now')
    expect(byText(container, 'was').closest('div').textContent).toBe('-was')
  })

  it('separates two regions of a file so the gutter jump is accounted for', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Edit', input: { file_path: '/repo/a.ts' }, state: 'completed' },
        {
          type: 'tool-result',
          output: 'ok',
          editPatch: {
            filePath: '/repo/a.ts',
            hunks: [
              { oldStart: 42, oldLines: 1, newStart: 42, newLines: 1, lines: ['-was', '+now'] },
              { oldStart: 310, oldLines: 1, newStart: 310, newLines: 1, lines: ['-old', '+new'] }
            ]
          }
        }
      ],
      expandSignal: true
    })

    const separators = container.querySelectorAll('[role="separator"]')
    expect(separators).toHaveLength(1)
    expect(separators[0].getAttribute('aria-label')).toBe('Lines not shown')
  })

  it('offers no empty body for a delete, which names the file and nothing else', () => {
    const { container } = render({
      blocks: [
        {
          type: 'tool-call',
          name: 'apply_patch',
          input: { input: '*** Begin Patch\n*** Delete File: gone.ts\n*** End Patch' },
          state: 'completed'
        }
      ],
      expandSignal: true
    })

    expect(byTitle(container, 'gone.ts')).toBeTruthy()
    // The header states the change; there is no body behind a disclosure.
    expect(byText(container, 'Deleted file').closest('button').hasAttribute('aria-expanded')).toBe(false)
  })

  it('says a diff was clipped even while the card is collapsed', () => {
    // A defined expandOverride opens the run while leaving each card closed.
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Diff', input: { path: 'src/a.ts' }, state: 'completed' },
        { type: 'tool-result', output: '@@ -1,3 +1,3 @@\n ctx\n-was\n+now\n… (48210 bytes)' }
      ],
      expandSignal: false,
      expandOverride: true
    })

    expect(queryByText(container, 'Diff truncated')).not.toBeNull()
    expect(queryByText(container, 'was')).toBeNull()
  })

  it('copies the diff as signed rows, with the region breaks left out', async () => {
    // Tessel's clipboard bridge (the reference used window.api.ui.writeClipboardText).
    const writeClipboard = vi.fn()
    prevShellApi = window.shellApi ?? null
    window.shellApi = { writeClipboard }
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Edit', input: { file_path: '/repo/a.ts' }, state: 'completed' },
        {
          type: 'tool-result',
          output: 'ok',
          editPatch: {
            filePath: '/repo/a.ts',
            hunks: [
              { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [' ctx', '-was', '+now'] },
              { oldStart: 90, oldLines: 1, newStart: 90, newLines: 1, lines: ['+tail'] }
            ]
          }
        }
      ],
      expandSignal: true
    })

    await click(buttonNamed(container, 'Copy diff'))

    expect(writeClipboard).toHaveBeenCalledWith(' ctx\n-was\n+now\n+tail')
  })

  describe('reading a batch as a group', () => {
    const batch = [
      {
        type: 'tool-call',
        name: 'mcp__linear__list_issues',
        input: { query: 'todo' },
        state: 'completed',
        mcpIdentity: { server: 'linear', tool: 'list_issues' }
      },
      { type: 'tool-call', name: 'Bash', input: { command: 'ls -la' }, state: 'completed' },
      { type: 'tool-call', name: 'read', input: { file_path: 'README.md' }, state: 'completed' }
    ]

    it('summarizes a run by category, in the order the run first used each one', () => {
      const { container } = render({ blocks: batch, expandSignal: false })

      expect(runHeader(container).textContent).toContain('Used 1 integration, ran 1 command, and read 1 file')
    })

    it('names no individual call in the header, however wide the run', () => {
      const { container } = render({ blocks: batch, expandSignal: false })

      const header = runHeader(container)
      expect(header.textContent).not.toContain('mcp__linear__list_issues')
      expect(header.textContent).not.toContain('ls -la')
      expect(header.textContent).not.toContain('README.md')
    })

    it('counts every call rather than capping the list and marking a remainder', () => {
      const wide = [
        ...batch,
        { type: 'tool-call', name: 'Grep', input: { pattern: 'todo' }, state: 'completed' },
        { type: 'tool-call', name: 'Write', input: { file_path: 'a.ts' }, state: 'completed' }
      ]

      const { container } = render({ blocks: wide, expandSignal: false })

      expect(runHeader(container).textContent).not.toContain('more')
      expect(runHeader(container).textContent).toContain(
        'Used 1 integration, ran 1 command, read 1 file, searched 1 time, and edited 1 file'
      )
    })

    it('joins exactly two categories with "and", and no comma', () => {
      const pair = [
        { type: 'tool-call', name: 'Bash', input: { command: 'ls' }, state: 'completed' },
        { type: 'tool-call', name: 'Bash', input: { command: 'pwd' }, state: 'completed' },
        { type: 'tool-call', name: 'read', input: { file_path: 'a.ts' }, state: 'completed' }
      ]

      const { container } = render({ blocks: pair, expandSignal: false })

      expect(runHeader(container).textContent).toContain('Ran 2 commands and read 1 file')
    })

    it('keeps the run in the transcript type, not a monospace dump', () => {
      const { container } = render({ blocks: batch, expandSignal: false })

      // The label's style (text-sm, not font-mono) lives in its class.
      const label = runHeader(container).querySelector('.nc-tool-run__label')
      expect(label).not.toBeNull()
      expect(label.tagName).toBe('SPAN')
      expect(label.closest('code')).toBeNull()
    })

    it('indents opened members so the run has a visible end', () => {
      const { container } = render({ blocks: batch, expandSignal: true })

      const members = runHeader(container).parentElement.querySelector('.nc-tool-run__members')
      expect(members).not.toBeNull()
      expect(members.querySelectorAll('button').length).toBe(batch.length)
    })

    // The split MCP name still appears on the row beneath; only the header has
    // stopped naming calls at all.
    it('prints the split MCP name on the opened row', () => {
      const { container } = render({ blocks: batch, expandSignal: true })

      expect(queryByText(container, 'Linear')).not.toBeNull()
    })

    it('gives a run whose tool it cannot name the generic category', () => {
      const { container } = render({
        blocks: [{ type: 'tool-call', name: '   ', input: {}, state: 'completed' }],
        expandSignal: false
      })

      expect(runHeader(container).textContent).toContain('Used 1 tool')
    })

    // A lone command is the one case where naming the call beats summarizing it.
    it('keeps a lone command as the header, unwrapped from its login shell', () => {
      const { container } = render({
        blocks: [
          { type: 'tool-call', name: 'shell', input: { command: `/bin/zsh -lc 'git push --force-with-lease'` }, state: 'completed' }
        ],
        expandSignal: false
      })

      expect(runHeader(container).textContent).toContain('git push --force-with-lease')
      expect(runHeader(container).textContent).not.toContain('/bin/zsh')
    })
  })

  it('keeps a grouped active run to one stable row showing only the latest tool', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'date' }, state: 'completed' },
        { type: 'tool-call', name: 'shell', input: { command: 'pwd' }, state: 'completed' },
        { type: 'tool-call', name: 'shell', input: { command: 'cat package.json' }, state: 'running' }
      ],
      expandSignal: false
    })

    // The sentence counts the call in flight and speaks in the present; the
    // latest call sits beside it. Earlier calls are one click away, not here.
    const header = runHeader(container)
    expect(header.textContent).toContain('Running 3 commands')
    expect(header.textContent).toContain('cat package.json')
    expect(header.textContent).not.toContain('date')
    expect(header.textContent).not.toContain('pwd')
    expect(byText(container, 'Running 3 commands').classList).toContain('nc-animate-pulse')
    expect(header.querySelector('.lucide-check')).toBeNull()
    expect(container.querySelector('.nc-animate-spin')).toBeNull()
  })

  it('treats legacy tool calls without lifecycle state as active while the turn works', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'sleep 5' } }],
      expandSignal: false,
      activeTurnIsWorking: true
    })

    expect(queryByText(container, 'Running 1 command')).not.toBeNull()
    expect(queryByText(container, 'sleep 5')).not.toBeNull()
  })

  it('keeps a completed tool payload collapsed until the run is expanded', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'printf hello' }, state: 'completed' },
        { type: 'tool-result', output: 'hello' }
      ],
      expandSignal: false
    })
    expect(queryByText(container, 'hello')).toBeNull()
  })

  // Live is the turn's state, and the header is one element from the first call
  // to the turn's end.
  it('keeps one header element from a call starting until its turn ends', async () => {
    const running = [{ type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }]
    const settled = [
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'completed' },
      { type: 'tool-result', output: 'done' }
    ]
    const { container, rerender } = render({ blocks: running, expandSignal: false, activeTurnIsWorking: true })
    const header = runHeader(container)
    expect(header.getAttribute('data-native-chat-tool-run-state')).toBe('live')
    expect(header.textContent).toContain('Running 1 command')
    expect(header.textContent).toContain('sleep 1')

    // The call settles; the turn has not. Same element, same words, no mark.
    await rerender({ blocks: settled, expandSignal: false, activeTurnIsWorking: true })
    expect(runHeader(container)).toBe(header)
    expect(header.getAttribute('data-native-chat-tool-run-state')).toBe('live')
    expect(header.textContent).toContain('Running 1 command')
    expect(header.querySelector('.lucide-check')).toBeNull()

    // The next call starts: still the same element, now counting it.
    const next = [...settled, { type: 'tool-call', name: 'shell', input: { command: 'sleep 2' }, state: 'running' }]
    await rerender({ blocks: next, expandSignal: false, activeTurnIsWorking: true })
    expect(runHeader(container)).toBe(header)
    expect(header.textContent).toContain('Running 2 commands')
    expect(header.textContent).toContain('sleep 2')

    // The turn ends: the same element settles in place.
    const done = [
      ...settled,
      { type: 'tool-call', name: 'shell', input: { command: 'sleep 2' }, state: 'completed' },
      { type: 'tool-result', output: 'done' }
    ]
    await rerender({ blocks: done, expandSignal: false, activeTurnIsWorking: false })
    expect(runHeader(container)).toBe(header)
    expect(header.getAttribute('data-native-chat-tool-run-state')).toBe('settled')
    expect(header.textContent).toContain('Ran 2 commands')
    expect(header.textContent).not.toContain('Running')
    expect(header.querySelector('.lucide-check')).not.toBeNull()
    expect(header.querySelector('.nc-animate-pulse')).toBeNull()
  })

  it('settles a run the agent has moved past even while its last call still reports', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }],
      expandSignal: false,
      activeTurnIsWorking: true,
      trailing: false
    })

    const header = runHeader(container)
    expect(header.getAttribute('data-native-chat-tool-run-state')).toBe('settled')
    expect(header.textContent).not.toContain('Running')
    expect(header.querySelector('.nc-animate-pulse')).toBeNull()
    // Still not a stated success: the call has not finished.
    expect(header.querySelector('.lucide-check')).toBeNull()
  })

  it('never animates a settled tool row with its completion check', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'pnpm test' }, state: 'completed' },
        { type: 'tool-result', output: 'passed' }
      ],
      expandSignal: false,
      activeTurnIsWorking: false
    })

    const settledRow = runHeader(container)
    expect(settledRow.textContent).toContain('pnpm test')
    expect(settledRow.querySelector('.lucide-check')).not.toBeNull()
    // Windowing remounts settled rows on scroll; a mark that faded in would replay.
    expect(settledRow.querySelector('.lucide-check').getAttribute('class')).not.toContain('animate')
    expect(container.querySelector('.nc-animate-pulse')).toBeNull()
  })

  it('refuses the completion mark to a collapsed run whose call failed', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'false' }, state: 'failed' },
        { type: 'tool-result', output: 'exit 1', isError: true }
      ],
      expandSignal: false
    })

    // Nothing was running, yet the header must not assert success over a failure.
    expect(container.querySelector('.lucide-check')).toBeNull()
    expect(runHeader(container).textContent).toContain('1 failed')
    expect(runHeader(container).querySelector('[aria-label]').getAttribute('aria-label')).toBe('Failed tool calls: 1')
    // Quiet text, not a severity escalation: no destructive tint, no swapped glyph.
    expect(container.querySelector('.lucide-circle-alert')).toBeNull()
    expect(container.querySelector('[class*="destructive"], [class*="error"]')).toBeNull()
    // The detail still belongs behind the disclosure.
    expect(queryByText(container, 'exit 1')).toBeNull()
  })

  it('counts every failed call in a run, not just the last one', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'a' }, state: 'failed' },
        { type: 'tool-result', output: 'exit 1', isError: true },
        { type: 'tool-call', name: 'shell', input: { command: 'b' }, state: 'failed' },
        { type: 'tool-result', output: 'exit 2', isError: true },
        { type: 'tool-call', name: 'shell', input: { command: 'c' }, state: 'completed' },
        { type: 'tool-result', output: 'ok' }
      ],
      expandSignal: false
    })

    expect(runHeader(container).textContent).toContain('2 failed')
    expect(container.querySelector('.lucide-check')).toBeNull()
  })

  it('says nothing and keeps the mark when every call in the run succeeded', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'a' }, state: 'completed' },
        { type: 'tool-result', output: 'ok' }
      ],
      expandSignal: false
    })

    expect(runHeader(container).textContent).not.toContain('failed')
    expect(container.querySelector('.lucide-check')).not.toBeNull()
  })

  it('keeps settled tool activity behind the completed turn disclosure', async () => {
    const blocks = [
      { type: 'tool-call', name: 'shell', input: { command: 'git log -1' }, state: 'failed' },
      { type: 'tool-result', output: 'exit 128', isError: true }
    ]

    const { container, rerender } = render({
      blocks,
      expandSignal: false,
      expandOverride: false,
      activeTurnIsWorking: false
    })

    expect(queryByText(container, 'git log -1')).toBeNull()
    expect(queryByText(container, 'exit 128')).toBeNull()

    await rerender({ blocks, expandSignal: false, expandOverride: true, activeTurnIsWorking: false })

    expect(runHeader(container).textContent).toContain('git log -1')
  })

  // Opening a turn lists the work; a call's output is one more click.
  it('keeps a call output behind the call row, not beside it', async () => {
    // Opened from the turn's own caret, which leaves each call's line collapsed.
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'shell', input: { command: 'git log -1' }, state: 'failed' },
        { type: 'tool-result', output: 'exit 128', isError: true }
      ],
      expandSignal: false,
      expandOverride: true,
      activeTurnIsWorking: false
    })

    expect(queryByText(container, 'Result')).toBeNull()
    expect(queryByText(container, 'exit 128')).toBeNull()

    // The row under the header, not the header itself, which names the same
    // command because the run is a single call.
    const rows = allByText(container, 'git log -1')
    await click(rows.at(-1).closest('button'))

    expect(queryByText(container, 'exit 128')).not.toBeNull()
  })

  it('keeps a post-turn running call neutral until the item itself settles', async () => {
    const { container, rerender } = render({
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'running' }],
      expandSignal: false,
      activeTurnIsWorking: false
    })

    expect(queryByText(container, 'Running sleep 1')).toBeNull()
    expect(container.querySelector('.lucide-check')).toBeNull()
    expect(container.querySelector('.lucide-circle-alert')).toBeNull()
    await rerender({
      blocks: [{ type: 'tool-call', name: 'shell', input: { command: 'sleep 1' }, state: 'completed' }],
      expandSignal: false,
      activeTurnIsWorking: false
    })
    expect(container.querySelector('.lucide-check')).not.toBeNull()
  })

  it('shows the category glyph beside the word a classified row is named by', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'read', input: { command: "sed -n '1,200p' notes.txt", path: 'notes.txt' }, state: 'completed' }
      ],
      expandSignal: true
    })

    const glyph = container.querySelector('.lucide-eye')
    expect(glyph).not.toBeNull()
    expect(glyph.getAttribute('aria-hidden')).toBe('true')
    expect(queryByText(container, 'read', 'code')).not.toBeNull()
  })

  it('holds one glyph for a category across running, completed, and failed', async () => {
    const searchCall = (state) => [{ type: 'tool-call', name: 'search', input: { query: 'beta' }, state }]
    const { container, rerender } = render({ blocks: searchCall('running'), expandSignal: true, activeTurnIsWorking: true })

    expect(leadingGlyphs(container)).toEqual(['search', 'search'])

    for (const settled of ['completed', 'failed']) {
      await rerender({ blocks: searchCall(settled), expandSignal: true, activeTurnIsWorking: false })

      // A leading check here would read as the row changing identity on settle.
      expect(leadingGlyphs(container)).toEqual(['search', 'search'])
    }
  })

  it('falls back to the generic tool glyph, not the terminal, for an unmodelled row', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'CreateWidget', input: { prompt: 'which?' }, state: 'completed' }],
      expandSignal: true
    })

    // A terminal here would assert a shell ran when nothing says one did.
    expect(container.querySelector('.lucide-square-terminal')).toBeNull()
    expect(container.querySelector('.lucide-wrench')).not.toBeNull()
  })

  it('agrees between the header and the row it names for an unmodelled tool', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'CreateWidget', input: { prompt: 'which?' }, state: 'completed' }],
      expandSignal: true
    })

    expect(leadingGlyphs(container)).toEqual(['wrench', 'wrench'])
  })

  // A result with no call to answer still draws its own row, and its word is
  // translated copy rather than a tool name.
  it('leaves an unpaired result row without a category glyph', () => {
    const { container } = render({ blocks: [{ type: 'tool-result', output: 'first line' }], expandSignal: true })

    const resultRow = byText(container, 'Result').closest('button')
    // Keying a category off 'Result' would resolve a different glyph per locale.
    expect([...resultRow.querySelectorAll('svg')].map(lucideName)).toEqual(['chevron-right'])
  })

  it('heads a projected diff run with the file-change glyph, not the generic one', () => {
    const projected = projectStructuredItemToNativeChat({
      itemId: 'file-change',
      revision: 1,
      sequence: 1,
      observedAt: 1,
      body: {
        kind: 'diff',
        path: 'src/a.ts',
        patch: { head: '@@ -1 +1 @@\n-was\n+now', truncated: false, byteLength: 24, digest: 'a'.repeat(64) }
      }
    })

    const { container } = render({ blocks: projected?.blocks ?? [], expandSignal: false, expandOverride: true })

    expect(container.querySelector('.lucide-pencil')).not.toBeNull()
    expect(container.querySelector('.lucide-wrench')).toBeNull()
  })

  describe('the settled header glyph over a whole run', () => {
    const call = (name, input) => ({ type: 'tool-call', name, input, state: 'completed' })

    it('heads a run that is all reads with the read glyph', () => {
      const { container } = render({
        blocks: [
          call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' }),
          call('read', { command: "sed -n '1,50p' b.ts", path: 'b.ts' })
        ],
        expandSignal: true,
        activeTurnIsWorking: false
      })

      expect(leadingGlyphs(container)).toEqual(['eye', 'eye', 'eye'])
    })

    it('heads a run that is all shell with the terminal glyph, whatever each is named', () => {
      const { container } = render({
        blocks: [call('shell', { command: 'npm test' }), call('Bash', { command: 'git status' })],
        expandSignal: true,
        activeTurnIsWorking: false
      })

      expect(leadingGlyphs(container)).toEqual(['square-terminal', 'square-terminal', 'square-terminal'])
    })

    it('heads a run spanning categories with the generic tool glyph', () => {
      const { container } = render({
        blocks: [call('shell', { command: 'npm test' }), call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' })],
        expandSignal: true,
        activeTurnIsWorking: false
      })

      expect(leadingGlyphs(container)).toEqual(['wrench', 'square-terminal', 'eye'])
    })

    it('heads a single-call run with that call’s own glyph', () => {
      const { container } = render({
        blocks: [call('Grep', { pattern: 'todo' })],
        expandSignal: true,
        activeTurnIsWorking: false
      })

      expect(leadingGlyphs(container)).toEqual(['search', 'search'])
    })

    it('leaves a run with no tool calls headed by no category glyph', () => {
      const { container } = render({
        blocks: [{ type: 'tool-result', output: 'first line' }],
        expandSignal: true,
        activeTurnIsWorking: false
      })

      // Only the trailing check and the chevron.
      expect(leadingGlyphs(container)).toEqual(['check', 'chevron-right'])
    })

    it('holds the run glyph across live and settled', async () => {
      const blocks = [
        call('read', { command: "sed -n '1,50p' a.ts", path: 'a.ts' }),
        { type: 'tool-call', name: 'shell', input: { command: 'npm test' }, state: 'running' }
      ]

      const { container, rerender } = render({ blocks, expandSignal: true, activeTurnIsWorking: true })

      expect(leadingGlyphs(container)[0]).toBe('wrench')
      await rerender({ blocks, expandSignal: true, activeTurnIsWorking: false })
      expect(leadingGlyphs(container)[0]).toBe('wrench')
    })
  })

  it('labels a bare list row by the command it ran rather than an invented path', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'list', input: { command: 'ls', cwd: '/repo' }, state: 'completed' }],
      expandSignal: true
    })

    expect(container.querySelector('.lucide-folder')).not.toBeNull()
    expect(byTitle(container, 'ls').textContent).toContain('ls')
  })

  // Hovering a single tool line must reveal that row's chevron only, not every
  // chevron of the message around it.
  describe('hover reveal', () => {
    const run = [
      { type: 'tool-call', name: 'Bash', input: { command: 'ls -la' }, state: 'completed' },
      { type: 'tool-result', output: 'a\nb' },
      { type: 'tool-call', name: 'Bash', input: { command: 'pwd' }, state: 'completed' },
      { type: 'tool-result', output: '/tmp' }
    ]

    function hoverRevealed(container) {
      return [...container.querySelectorAll('[class*="hover-reveal"]')]
    }

    it('puts every reveal inside the row button that governs it', () => {
      // Open run, collapsed children — the state the turn caret leaves behind.
      const { container } = render({ blocks: run, expandSignal: false, expandOverride: true })

      const revealed = hoverRevealed(container)
      expect(revealed.length).toBeGreaterThan(0)
      for (const element of revealed) {
        const scope = /nc-(tool-line|tool-run)__chevron--hover-reveal/.exec(element.getAttribute('class'))?.[1]
        expect(scope).toBeDefined()
        const row = element.closest('button')
        const rowClass = scope === 'tool-line' ? 'nc-tool-line' : 'nc-tool-run__header'
        expect(row.classList).toContain(rowClass)
      }
    })

    it('hides a collapsed chevron on every row until its own row is hovered', () => {
      const { container } = render({ blocks: run, expandSignal: false, expandOverride: true })

      const chevrons = [...container.querySelectorAll('.nc-tool-run__members button svg.lucide-chevron-right')]
      expect(chevrons.length).toBeGreaterThan(1)
      for (const chevron of chevrons) {
        expect(chevron.getAttribute('class')).toContain('nc-tool-line__chevron--hover-reveal')
      }
    })
  })
})

describe('NativeChatToolRun task lists', () => {
  it('renders task updates instead of JSON and consumes successful results', () => {
    const { container } = render({
      blocks: [
        {
          type: 'tool-call',
          name: 'update_plan',
          input: { plan: [{ step: 'Read', status: 'in_progress' }, { step: 'Test', status: 'pending' }] }
        },
        { type: 'tool-result', output: 'Plan updated' },
        {
          type: 'tool-call',
          name: 'update_plan',
          input: { plan: [{ step: 'Read', status: 'completed' }, { step: 'Test', status: 'in_progress' }] }
        }
      ],
      expandSignal: true
    })
    expect(queryByText(container, 'Completed Read')).not.toBeNull()
    expect(queryByText(container, 'Started Test')).not.toBeNull()
    expect(queryByText(container, '1/2')).not.toBeNull()
    expect(queryByText(container, 'Plan updated')).toBeNull()
    expect(container.querySelector('pre')).toBeNull()
  })

  it('keeps malformed calls and failed results visible in the generic view', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'TodoWrite', input: '{' },
        { type: 'tool-result', output: 'Invalid arguments', isError: true },
        { type: 'tool-call', name: 'TodoWrite', input: { todos: [{ content: 'Test', status: 'completed' }] } },
        { type: 'tool-result', output: 'Update rejected', isError: true }
      ],
      expandSignal: true
    })
    expect(queryByText(container, 'Invalid arguments', 'pre')).not.toBeNull()
    expect(queryByText(container, 'Update rejected', 'pre')).not.toBeNull()
    expect(queryByText(container, '1/1')).toBeNull()
  })
})

describe('NativeChatToolRun (Tessel protections)', () => {
  const secret = 'sk-ant-api03-AbCdEfGhIjKlMnOpQrStUvWxYz0123456789'

  it('masks a secret in a lone command header and in its opened row', () => {
    const { container } = render({
      blocks: [
        {
          type: 'tool-call',
          name: 'Bash',
          input: { command: `curl -H "Authorization: Bearer ${secret}" https://api.example.com --data token=hunter2` },
          state: 'completed'
        }
      ],
      expandSignal: true
    })

    expect(container.textContent).not.toContain(secret)
    expect(container.textContent).not.toContain('hunter2')
    expect(runHeader(container).textContent).toContain('***')
    // The opened row's preview and its title carry the masked text too.
    const preview = container.querySelector('.nc-tool-line__preview')
    expect(preview.textContent).toContain('***')
    expect(preview.getAttribute('title')).not.toContain(secret)
  })

  it('masks a secret before the preview is clipped, so no half of it survives', () => {
    // A long command: the label is cut, and the key sits across the cut.
    const command = `${'echo padding && '.repeat(6)}export API_KEY=${secret} && npm publish`
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'Bash', input: { command }, state: 'running' }],
      expandSignal: true,
      activeTurnIsWorking: true
    })

    const text = container.textContent
    expect(text).not.toContain(secret)
    expect(text).not.toContain(secret.slice(0, 16))
    for (const node of container.querySelectorAll('[title]')) {
      expect(node.getAttribute('title')).not.toContain(secret.slice(0, 16))
    }
  })

  it('masks credential-named fields of an opened input detail', async () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'mcp__stripe__create', input: { apiKey: 'plainsecretvalue', amount: 5 }, state: 'completed' }
      ],
      expandSignal: true
    })

    const detail = container.querySelector('pre')
    expect(detail.textContent).toContain('"amount": 5')
    expect(detail.textContent).not.toContain('plainsecretvalue')
    expect(detail.textContent).toContain('***')
  })

  it('a stopped tool says Stopped, neither failed nor running, and is never marked done', () => {
    const { container } = render({
      blocks: [{ type: 'tool-call', name: 'Bash', input: { command: 'sleep 9' }, state: 'interrupted' }],
      expandSignal: true,
      activeTurnIsWorking: false
    })

    const header = runHeader(container)
    expect(header.getAttribute('data-native-chat-tool-run-state')).toBe('settled')
    expect(header.textContent).toContain('1 stopped')
    expect(header.textContent).not.toContain('failed')
    expect(header.textContent).not.toContain('Running')
    expect(header.querySelector('.lucide-check')).toBeNull()
    expect(container.querySelector('.nc-animate-pulse')).toBeNull()
    const line = container.querySelector('.nc-tool-line')
    expect(line.querySelector('[data-native-chat-tool-state="stopped"]').textContent).toBe('Stopped')
  })

  it('says Stopped for a cancelled call too, beside its partial output', async () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Bash', input: { command: 'npm test' }, state: 'cancelled' },
        { type: 'tool-result', output: 'partial' }
      ],
      expandSignal: true,
      activeTurnIsWorking: false
    })

    expect(container.querySelector('.nc-tool-line [data-native-chat-tool-state="stopped"]').textContent).toBe('Stopped')
    expect(container.querySelector('.nc-tool-line__pre--error')).toBeNull()
  })

  it('shows tool output as text, never as HTML', () => {
    const { container } = render({
      blocks: [
        { type: 'tool-call', name: 'Bash', input: { command: 'cat x.html' }, state: 'completed' },
        { type: 'tool-result', output: '<img src=x onerror="alert(1)"><b>bold</b>' }
      ],
      expandSignal: true
    })

    // The call's own line is collapsed by default only when the run is opened
    // externally; here it is open, so the output is on screen, as text.
    const pre = [...container.querySelectorAll('pre')].find((node) => node.textContent.includes('<b>bold</b>'))
    expect(pre).toBeTruthy()
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('b')).toBeNull()
  })
})
