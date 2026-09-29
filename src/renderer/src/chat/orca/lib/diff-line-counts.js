// After Orca's components/right-sidebar/source-control/listing/diff-line-counts.tsx
// (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// "+12 -3" beside a changed file. A render-function component so the chat's
// diff rows can use it without a .vue of their own; the git decoration tokens
// (orca-tokens.css) colour the two counts. Classes: nc-diff-line-counts.
import { defineComponent, h } from 'vue'

export const DiffLineCounts = defineComponent({
  name: 'DiffLineCounts',
  props: {
    added: { type: Number, default: undefined },
    removed: { type: Number, default: undefined }
  },
  setup(props) {
    return () => {
      const hasAdded = typeof props.added === 'number' && props.added > 0
      const hasRemoved = typeof props.removed === 'number' && props.removed > 0
      if (!hasAdded && !hasRemoved) return null
      // shrink-0 tabular-nums text-[10px]
      return h(
        'span',
        {
          class: 'nc-diff-line-counts',
          style: { flexShrink: 0, fontVariantNumeric: 'tabular-nums', fontSize: '10px' }
        },
        [
          hasAdded ? h('span', { style: { color: 'var(--nc-git-added)' } }, `+${props.added}`) : null,
          hasAdded && hasRemoved ? h('span', ' ') : null,
          hasRemoved ? h('span', { style: { color: 'var(--nc-git-deleted)' } }, `-${props.removed}`) : null
        ]
      )
    }
  }
})

export default DiffLineCounts
