<script setup>
// After Orca's NativeChatPromptEditor.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
// The composer's input: a TipTap editor (plain paragraphs + skill pills) that
// looks like a textarea to the composer hooks. `inputRef` (a Vue ref) gets a
// NativeChatComposerInput: value (plain text, skills as their token),
// selectionStart/End (plain-text offsets), disabled, focus(), contains(),
// select(), setSelectionRange(), insertSkill(from, to, token).
// Props: scopeKey (restores this pane's pills from the draft cache),
//   inputRef, initialValue, disabled, placeholder (also its aria-label).
// Emits: change(input) on every edit, select(input) on selection moves.
// Attributes: class, aria-* and data-test go to the editable element; the
// rest (listeners such as @keydown.capture, @paste.capture, @blur,
// @compositionstart) go to the element around it.
import { computed, onBeforeUnmount, useAttrs, watch } from 'vue'
import { EditorContent, useEditor } from '@tiptap/vue-3'
import StarterKit from '@tiptap/starter-kit'
import Placeholder from '@tiptap/extension-placeholder'
import { closeHistory } from '@tiptap/pm/history'
import { Slice } from '@tiptap/pm/model'
import { readNativeChatDraftDocument, writeNativeChatDraftDocument } from '../../../chat/orca/native-chat-draft-cache.js'
import { NativeChatSkill, promptTextContent, promptTextMap, promptTextOffset } from './native-chat-prompt-document.js'

defineOptions({ inheritAttrs: false })
const props = defineProps({
  scopeKey: { type: String, default: undefined },
  inputRef: { type: Object, required: true },
  initialValue: { type: String, default: '' },
  disabled: { type: Boolean, default: false },
  placeholder: { type: String, default: '' }
})
const emit = defineEmits(['change', 'select'])
const attrs = useAttrs()

const toEditor = (key) => key === 'class' || key.startsWith('aria-') || key === 'data-test'
const editorAttrs = computed(() => Object.fromEntries(Object.entries(attrs).filter(([key]) => toEditor(key))))
const events = computed(() => Object.fromEntries(Object.entries(attrs).filter(([key]) => !toEditor(key))))

function classString(value) {
  if (!value) return ''
  if (typeof value === 'string') return value
  if (Array.isArray(value)) return value.map(classString).filter(Boolean).join(' ')
  return Object.entries(value).filter(([, on]) => on).map(([name]) => name).join(' ')
}

function editorProps() {
  const { class: className, ...rest } = editorAttrs.value
  return {
    attributes: {
      role: 'textbox',
      'aria-multiline': 'true',
      'aria-label': props.placeholder,
      class: `${classString(className)} nc-prompt-editor`, // i18n-ignore
      ...Object.fromEntries(Object.entries(rest).filter(([, value]) => value != null).map(([key, value]) => [key, String(value)]))
    },
    // Clipboard input is always literal text; only the picker creates skill nodes.
    handlePaste: (view, event) => {
      if (event.defaultPrevented) return true
      const text = event.clipboardData?.getData('text/plain')
      if (text == null) return false
      const content = editor.value?.schema.nodeFromJSON(promptTextContent(text))
      if (!content) return false
      view.dispatch(view.state.tr.replaceSelection(new Slice(content.content, 1, 1)))
      return true
    },
    clipboardTextSerializer: (slice) =>
      slice.content.textBetween(0, slice.content.size, '\n', (node) =>
        node.type.name === 'hardBreak' ? '\n' : String(node.attrs.token ?? '')
      )
  }
}

const editor = useEditor({
  extensions: [
    StarterKit.configure({
      blockquote: false,
      bold: false,
      bulletList: false,
      code: false,
      codeBlock: false,
      dropcursor: false,
      gapcursor: false,
      heading: false,
      horizontalRule: false,
      italic: false,
      link: false,
      listItem: false,
      orderedList: false,
      strike: false,
      underline: false,
      trailingNode: false
    }),
    NativeChatSkill,
    Placeholder.configure({ placeholder: () => props.placeholder })
  ],
  content:
    (props.scopeKey && readNativeChatDraftDocument(props.scopeKey, props.initialValue)) ||
    promptTextContent(props.initialValue),
  editable: !props.disabled,
  editorProps: editorProps(),
  onTransaction: ({ editor: current, transaction }) => {
    if (props.scopeKey && transaction.docChanged) {
      writeNativeChatDraftDocument(props.scopeKey, promptTextMap(current.state.doc).text, current.getJSON())
    }
  },
  onUpdate: () => {
    if (props.inputRef.value) emit('change', props.inputRef.value)
  },
  onSelectionUpdate: () => {
    if (props.inputRef.value) emit('select', props.inputRef.value)
  }
})

// React re-applied the options on every render; here only what can change:
// the placeholder (aria-label + the empty-line decoration) and the attributes.
watch([() => props.placeholder, editorAttrs], () => {
  const current = editor.value
  if (current && !current.isDestroyed) current.setOptions({ editorProps: editorProps() })
})

watch(
  () => props.disabled,
  (disabled) => editor.value?.setEditable(!disabled, false)
)

function createInput(current) {
  return {
    get value() {
      return promptTextMap(current.state.doc).text
    },
    set value(value) {
      const old = promptTextMap(current.state.doc)
      if (old.text === value) return
      if (!value) {
        current.commands.setContent(promptTextContent(''), { emitUpdate: false })
        return
      }
      let start = 0
      while (start < old.text.length && start < value.length && old.text[start] === value[start]) {
        start++
      }
      let end = 0
      while (
        end < old.text.length - start &&
        end < value.length - start &&
        old.text[old.text.length - 1 - end] === value[value.length - 1 - end]
      ) {
        end++
      }
      // A text replacement intersecting an atom replaces its entire serialized token.
      while (start > 0 && old.positions[start - 1] === old.positions[start]) {
        start--
      }
      while (end > 0 && old.positions[old.text.length - end] === old.positions[old.text.length - end - 1]) {
        end--
      }
      const content = current.schema.nodeFromJSON(promptTextContent(value.slice(start, value.length - end)))
      current.commands.command(({ tr }) => {
        tr.replaceRange(old.positions[start], old.positions[old.text.length - end], new Slice(content.content, 1, 1))
        tr.setMeta('preventUpdate', true)
        return true
      })
    },
    get disabled() {
      return !current.isEditable
    },
    set disabled(value) {
      current.setEditable(!value)
    },
    get selectionStart() {
      return promptTextOffset(current.state.doc, current.state.selection.from)
    },
    get selectionEnd() {
      return promptTextOffset(current.state.doc, current.state.selection.to)
    },
    focus: () => {
      current.view.dom.focus()
    },
    contains: (node) => current.view.dom.contains(node),
    select: () => {
      current.commands.selectAll()
    },
    setSelectionRange: (from, to) => {
      // A caret set a frame later (after a mention is inserted) may come
      // after the composer closed: its editor is gone by then.
      if (!current || current.isDestroyed) return
      const { positions } = promptTextMap(current.state.doc)
      current.commands.setTextSelection({
        from: positions[Math.min(from ?? 0, positions.length - 1)],
        to: positions[Math.min(to ?? 0, positions.length - 1)]
      })
    },
    insertSkill: (from, to, token) => {
      const { positions } = promptTextMap(current.state.doc)
      current.view.dispatch(closeHistory(current.state.tr))
      current
        .chain()
        .insertContentAt({ from: positions[from], to: positions[to] }, [
          { type: 'nativeChatSkill', attrs: { token } },
          { type: 'text', text: ' ' }
        ])
        .run()
      current.view.dispatch(closeHistory(current.state.tr))
    },
    // The editable element (focus checks, tests).
    get element() {
      return current.view.dom
    }
  }
}

let ownInput = null
watch(
  editor,
  (current) => {
    ownInput = current ? createInput(current) : null
    props.inputRef.value = ownInput
  },
  { flush: 'sync' }
)
onBeforeUnmount(() => {
  if (props.inputRef.value === ownInput) props.inputRef.value = null
})

defineExpose({ editor })
</script>

<template>
  <EditorContent :editor="editor" v-bind="events" />
</template>

<style>
/* The editable element is built by ProseMirror (not by this template), so these
   rules are global and keyed on its class. whitespace-pre-wrap break-words
   [&_p]:m-0 + the empty-editor placeholder. */
.nc-prompt-editor {
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.nc-prompt-editor p {
  margin: 0;
}
.nc-prompt-editor p.is-editor-empty:first-child::before {
  content: attr(data-placeholder);
  color: color-mix(in srgb, var(--nc-muted-foreground) 60%, transparent);
  float: left;
  height: 0;
  pointer-events: none;
}
/* The skill pill before its Vue node view is attached (renderHTML):
   inline-flex items-center gap-1 rounded-full border border-border bg-muted
   px-1.5 text-xs font-medium text-muted-foreground align-baseline select-none */
.nc-skill-pill-html {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  border: 1px solid var(--nc-border);
  border-radius: 9999px;
  background: var(--nc-muted);
  padding: 0 6px;
  font-size: 12px;
  line-height: 16px;
  font-weight: 500;
  color: var(--nc-muted-foreground);
  vertical-align: baseline;
  user-select: none;
}
</style>
