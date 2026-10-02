<script>
// After Orca's NativeChatCodeBlock.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * Code fences need their own copy target rather than the whole chat message.
 * Props: language (the fence's info word; no header without one).
 * Slot: the code (e.g. <code>{{ text }}</code>); its text is what Copy copies.
 * Used by ChatMarkdown as its renderCodeBlock, and by the approval card.
 */
import { Comment, Fragment, Text, defineComponent, h, isVNode } from 'vue'
import { Code2, FolderOpen } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { getCodeBlockLanguageLabel } from './rich-markdown-code-block-languages.js'
import NativeChatCopyButton from './NativeChatCopyButton.vue'
import { chatPathProblem } from '../../../../../shared/chatFileLinks.js'

// Tessel: a block that is only a local file or folder path ("C:\x\a.png",
// "/home/x/a.png") gets Show in Folder next to Copy. -> the path or ''.
export function codeBlockPath(code) {
  const text = String(code || '').trim()
  if (!text || text.length > 1024 || /[\r\n]/.test(text)) return ''
  if (!/^(?:[A-Za-z]:[\\/]|\/)/.test(text)) return ''
  const problem = chatPathProblem(text)
  return problem && problem !== 'executable' ? '' : text
}
function revealButton(path) {
  const api = typeof window !== 'undefined' && window.shellApi && window.shellApi.chatFiles
  if (!path || !api || typeof api.reveal !== 'function') return null
  const label = t('chat.orca.contextMenu.revealFile', 'Show in Folder')
  return h(
    'button',
    { type: 'button', class: 'nc-code-reveal', title: label, 'aria-label': label, 'data-test': 'code-reveal', onClick: () => api.reveal(path) },
    [h(FolderOpen, { class: 'nc-code-reveal-icon', 'aria-hidden': 'true' })]
  )
}

// The text of the slot's vnodes (the reference walks React children).
export function extractCodeText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(extractCodeText).join('')
  if (isVNode(node)) {
    if (node.type === Comment) return ''
    if (node.type === Text) return String(node.children ?? '')
    if (node.type === Fragment || typeof node.type === 'string')
      return extractCodeText(node.children)
    return ''
  }
  return ''
}

export default defineComponent({
  name: 'NativeChatCodeBlock',
  props: {
    language: { type: String, default: undefined }
  },
  setup(props, { slots }) {
    return () => {
      const children = slots.default?.() ?? []
      const code = extractCodeText(children)
      const language = props.language
      const copyLabel = t('chat.orca.copyCode', 'Copy code')
      const reveal = revealButton(codeBlockPath(code))
      return h('div', { class: 'nc-code-block' }, [
        language
          ? h('div', { class: 'nc-code-header' }, [
              h('span', { 'data-code-language': language, class: 'nc-code-language' }, [
                h(Code2, { class: 'nc-code-language-icon', 'aria-hidden': 'true' }),
                h('span', { class: 'nc-code-language-label' }, getCodeBlockLanguageLabel(language))
              ]),
              h('span', { class: 'nc-code-actions-inline' }, [
                reveal,
                code
                  ? h(NativeChatCopyButton, {
                      text: code,
                      label: copyLabel,
                      class: 'nc-code-copy-inline'
                    })
                  : null
              ])
            ])
          : null,
        h(
          'pre',
          { class: ['nc-code-pre', 'nc-scrollbar-sleek', { 'is-bare': !language }] },
          children
        ),
        code && !language
          ? h('div', { class: 'nc-code-copy-float' }, [reveal, h(NativeChatCopyButton, { text: code, label: copyLabel })])
          : null
      ])
    }
  }
})
</script>

<style scoped>
.nc-code-block {
  position: relative;
  margin: 12px 0;
  min-width: 0;
  max-width: 100%;
  overflow: hidden;
  border-radius: 6px;
  background: var(--nc-accent);
}
.nc-code-header {
  display: flex;
  height: 36px;
  align-items: center;
  justify-content: space-between;
  border-bottom: 1px solid color-mix(in srgb, var(--nc-border) 60%, transparent);
  padding: 0 12px;
}
.nc-code-language {
  display: flex;
  min-width: 0;
  align-items: center;
  gap: 6px;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
.nc-code-language-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.nc-code-language-label {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.nc-code-copy-inline {
  margin-right: -4px;
}
.nc-code-pre {
  margin: 0;
  max-height: 320px;
  max-width: 100%;
  overflow-x: auto;
  padding: 12px;
  font-family:
    ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New',
    monospace;
  font-size: 12px;
  background: transparent;
  color: inherit;
  scrollbar-width: thin;
  scrollbar-color: color-mix(in srgb, var(--text-dim) 40%, transparent) transparent;
}
.nc-code-pre.is-bare {
  padding-right: 40px;
}
/* The fence's <code>: no inline-code pill inside a block. */
.nc-code-pre :deep(code) {
  padding: 0;
  border-radius: 0;
  background: transparent;
  font: inherit;
}
.nc-code-actions-inline {
  display: flex;
  align-items: center;
  gap: 2px;
}
.nc-code-reveal {
  display: flex;
  width: 24px;
  height: 24px;
  flex-shrink: 0;
  align-items: center;
  justify-content: center;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--nc-muted-foreground);
  cursor: pointer;
}
.nc-code-reveal:hover {
  background: color-mix(in srgb, var(--nc-foreground) 10%, transparent);
  color: var(--nc-foreground);
}
.nc-code-reveal-icon {
  width: 14px;
  height: 14px;
}
.nc-code-copy-float {
  display: flex;
  gap: 2px;
  position: absolute;
  right: 8px;
  top: 8px;
  opacity: 1;
  transition-property: opacity;
  transition-duration: 150ms;
}
@media (hover: hover) {
  .nc-code-copy-float {
    pointer-events: none;
    opacity: 0;
  }
  .nc-code-block:hover .nc-code-copy-float,
  .nc-code-block:has(:focus-visible) .nc-code-copy-float {
    pointer-events: auto;
    opacity: 1;
  }
}
</style>
