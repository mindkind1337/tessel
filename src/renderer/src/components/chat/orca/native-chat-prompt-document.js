// After Orca's native-chat-prompt-document.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// The prompt editor's document model: plain paragraphs plus atomic skill nodes
// (only the picker creates them), and the map between plain-text offsets and
// ProseMirror positions the composer hooks work with.
import { Node, VueNodeViewRenderer } from '@tiptap/vue-3'
import NativeChatSkillPill from './NativeChatSkillPill.vue'

export const NativeChatSkill = Node.create({
  name: 'nativeChatSkill',
  group: 'inline',
  inline: true,
  atom: true,
  selectable: true,
  addNodeView: () => VueNodeViewRenderer(NativeChatSkillPill),
  addAttributes: () => ({ token: { default: '' } }),
  renderText: ({ node }) => node.attrs.token,
  // Before the Vue node view is attached (and in copied HTML): the same pill as plain HTML.
  renderHTML: ({ node }) => [
    'span',
    {
      'data-native-chat-skill': node.attrs.token,
      contenteditable: 'false',
      class: 'nc-skill-pill-html'
    },
    ['span', { 'aria-hidden': 'true' }, 'ϟ'],
    ['span', {}, String(node.attrs.token).slice(1)]
  ]
})

export function promptTextContent(text) {
  return {
    type: 'doc',
    content: text.split('\n').map((line) => ({
      type: 'paragraph',
      content: line ? [{ type: 'text', text: line }] : []
    }))
  }
}

/** Each boundary maps a plain-text caret to a document position, including atomic skills. */
export function promptTextMap(doc) {
  let text = ''
  const positions = [1]
  doc.forEach((block, blockOffset, index) => {
    if (index > 0) {
      text += '\n'
      positions.push(blockOffset + 1)
    }
    block.forEach((node, offset) => {
      const start = blockOffset + 1 + offset
      const value = node.isText
        ? node.text
        : node.type.name === 'hardBreak'
          ? '\n'
          : String(node.attrs.token ?? '')
      for (let i = 0; i < value.length; i++) {
        text += value[i]
        positions.push(
          node.isText ? start + i + 1 : i === value.length - 1 ? start + node.nodeSize : start
        )
      }
    })
  })
  return { text, positions }
}

export function promptTextOffset(doc, position) {
  const { positions } = promptTextMap(doc)
  const index = positions.findIndex((candidate) => candidate >= position)
  return index === -1 ? positions.length - 1 : index
}
