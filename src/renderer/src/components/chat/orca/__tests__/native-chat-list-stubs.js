// Stand-ins for the rows other lots render inside the transcript
// (NativeChatMessageRow, NativeChatResolutionReceipt, NativeChatTurnDiffRollup,
// NativeChatTaskList). They draw just enough to test what the LIST owns: which
// rows mount, what each row is handed, the disclosure store surviving
// windowing, and the diff-reveal / scroll-to-top plumbing.
// Use from a spec (vi.mock factories are hoisted, so import inside them):
//   vi.mock('../NativeChatMessageRow.vue', async () => ({ default: (await import('./native-chat-list-stubs.js')).MessageRowStub }))
import { defineComponent, h, onMounted, ref, watch } from 'vue'
import { useNativeChatDisclosure } from '../../../../chat/orca/composables/native-chat-disclosure-store.js'

/** message id → how many times its row rendered. */
export const rowRenders = new Map()
export function resetRowRenders() {
  rowRenders.clear()
}

function toolLabel(block) {
  const input = block.input ?? {}
  return String(input.command ?? input.file_path ?? input.path ?? block.name ?? 'tool')
}

// One tool run, open/closed through the list's disclosure store like the real run.
const ToolRunStub = defineComponent({
  name: 'ToolRunStub',
  props: { disclosureKey: { type: String, required: true }, label: { type: String, required: true } },
  setup(props) {
    const { open, setOpen } = useNativeChatDisclosure(() => props.disclosureKey, false)
    return () =>
      h(
        'button',
        {
          type: 'button',
          'data-stub': 'tool-run',
          'aria-expanded': open.value ? 'true' : 'false',
          onClick: () => setOpen(!open.value)
        },
        props.label
      )
  }
})

/** A rollup's file button (the row's own tool buttons may carry the same path). */
export function rollupFile(path) {
  const button = Array.from(document.querySelectorAll('[data-stub="turn-diff-file"]')).find(
    (element) => element.textContent === path
  )
  if (!button) throw new Error(`no rollup file ${path}`)
  return button
}

export const MessageRowStub = defineComponent({
  name: 'NativeChatMessageRow',
  props: {
    message: { type: Object, required: true },
    previousTodoWrite: { type: null, default: undefined },
    previousUpdatePlan: { type: null, default: undefined },
    revealedDiff: { type: Object, default: undefined },
    expandSignal: { type: Boolean, default: false },
    activeTurnIsWorking: { type: Boolean, default: false },
    trailingRun: { type: Boolean, default: false },
    onScrollMessageToTop: { type: Function, default: undefined },
    onLinkClick: { type: Function, default: undefined },
    allowFileUriLinks: { type: Boolean, default: false },
    deliveryFailed: { type: Boolean, default: false },
    structuredActivityUi: { type: Boolean, default: false },
    folded: { type: Boolean, default: false },
    runtimeContext: { type: Object, default: null }
  },
  setup(props) {
    const root = ref(null)
    // The real row scrolls its revealed diff card to the top of the viewport.
    const scrollRevealed = () => {
      const card = root.value?.querySelector('[data-stub="revealed-diff"]')
      if (card && props.onScrollMessageToTop) props.onScrollMessageToTop(card)
    }
    onMounted(scrollRevealed)
    watch(() => props.revealedDiff?.requestId, scrollRevealed, { flush: 'post' })
    return () => {
      const message = props.message
      rowRenders.set(message.id, (rowRenders.get(message.id) ?? 0) + 1)
      const text = message.blocks
        .filter((block) => block.type === 'text')
        .map((block) => block.text)
        .join('\n')
      const tools = message.blocks.filter((block) => block.type === 'tool-call')
      const children = []
      if (!props.folded) {
        if (text) children.push(h('p', text))
        tools.forEach((block, index) =>
          children.push(
            h(ToolRunStub, { key: index, disclosureKey: `${message.id}:tool:${index}`, label: toolLabel(block) })
          )
        )
      }
      if (props.revealedDiff) children.push(h('div', { 'data-stub': 'revealed-diff' }, 'Edited file'))
      return h(
        'div',
        {
          ref: root,
          'data-stub': 'message-row',
          'data-message-id': message.id,
          'data-role': message.role,
          'data-folded': String(props.folded),
          'data-trailing-run': String(props.trailingRun),
          'data-active-turn-is-working': String(props.activeTurnIsWorking),
          'data-structured-activity-ui': String(props.structuredActivityUi),
          'data-delivery-failed': String(props.deliveryFailed),
          'data-expand-signal': String(props.expandSignal),
          'data-allow-file-uri-links': String(props.allowFileUriLinks)
        },
        children
      )
    }
  }
})

export const ResolutionReceiptStub = defineComponent({
  name: 'NativeChatResolutionReceipt',
  props: { body: { type: Object, required: true }, disclosureId: { type: String, default: undefined } },
  setup(props) {
    return () =>
      h('div', { 'data-native-chat-receipt': '', 'data-disclosure-id': props.disclosureId }, [
        h(
          'span',
          props.body.resolution?.state === 'pending'
            ? 'Awaiting user input:'
            : props.body.kind === 'approval'
              ? 'Resolved'
              : 'Asked:'
        ),
        h('span', props.body.title ?? props.body.question ?? '')
      ])
  }
})

export const TurnDiffRollupStub = defineComponent({
  name: 'NativeChatTurnDiffRollup',
  props: { diff: { type: Object, required: true } },
  emits: ['reveal'],
  setup(props, { emit }) {
    const open = ref(false)
    return () => {
      const count = props.diff.files.length
      const header = h(
        'button',
        {
          type: 'button',
          'data-stub': 'turn-diff',
          'aria-expanded': open.value ? 'true' : 'false',
          onClick: () => (open.value = !open.value)
        },
        count === 1 ? '1 changed file' : `${count} changed files`
      )
      const files = open.value
        ? props.diff.files.map((file) =>
            h(
              'button',
              { type: 'button', key: file.path, 'data-stub': 'turn-diff-file', onClick: () => emit('reveal', file.target) },
              file.path
            )
          )
        : []
      return h('div', [header, ...files])
    }
  }
})

export const TaskListStub = defineComponent({
  name: 'NativeChatTaskList',
  props: { list: { type: Object, required: true }, presentation: { type: String, default: undefined } },
  setup(props) {
    // Local state, so a remount (the list keys it by session) shows as a reset.
    const expanded = ref(false)
    return () => {
      const done = props.list.tasks.filter((task) => task.status === 'completed').length
      return h('div', { 'data-stub': 'task-list', 'data-presentation': props.presentation }, [
        h(
          'button',
          {
            type: 'button',
            'aria-expanded': expanded.value ? 'true' : 'false',
            onClick: () => (expanded.value = !expanded.value)
          },
          `Tasks ${done} of ${props.list.tasks.length} tasks completed`
        ),
        h(
          'ul',
          props.list.tasks.map((task, index) => h('li', { key: index }, task.content ?? task.step ?? ''))
        )
      ])
    }
  }
})
