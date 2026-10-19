<script setup>
// A commit hash in text an agent (or you) wrote (links/commitRefs.js): plain
// text until the repository of the pane that wrote it says it is a commit
// there (asked when the pointer reaches it, or on a click; eager: when it is
// shown, the Media view's list), then a link: its subject, author and date
// on hover, a click shows it in Source Control, Ctrl+click copies its full
// hash (the link router, links/openTarget.js). Never a link to nothing: one
// that is not a commit there stays text, and its click is the surface's.
import { computed, onMounted, ref, watch } from 'vue'
import { cachedCommit, commitTarget, commitTip, resolveCommit } from '../links/commitLinks'
import { openTarget } from '../links/openTarget'

const props = defineProps({
  hash: { type: String, required: true },
  // The repository folder it is read against (commitLinks.js commitRootOf).
  root: { type: String, default: null },
  eager: { type: Boolean, default: false }
})
const emit = defineEmits(['resolved'])

const known = () => (props.root ? cachedCommit(props.root, props.hash) : null)
// info: { id, subject, author, timestamp }, null (not a commit there) or
// undefined (not asked yet).
const info = ref(known())
watch(
  () => [props.root, props.hash],
  () => (info.value = known())
)
const tip = computed(() => (info.value ? commitTip(info.value) : ''))

async function check() {
  if (!props.root) return null
  if (info.value !== undefined) return info.value
  const root = props.root
  const hash = props.hash
  const res = await resolveCommit(root, hash)
  if (root === props.root && hash === props.hash) {
    info.value = res
    emit('resolved', res)
  }
  return res
}
onMounted(() => {
  if (info.value !== undefined) emit('resolved', info.value)
  else if (props.eager) check()
})

function open(res, event) {
  return openTarget(commitTarget(props.root, res), { event })
}
function onClick(event) {
  if (!props.root || info.value === null) return
  if (info.value) {
    event.preventDefault()
    event.stopPropagation()
    open(info.value, event)
    return
  }
  // Clicked before the pointer rested on it (a touch): asked now, opened
  // once known.
  const keys = { ctrlKey: event.ctrlKey, metaKey: event.metaKey }
  check().then((res) => res && open(res, keys))
}
function onKey(event) {
  if (!info.value) return
  event.preventDefault()
  event.stopPropagation()
  open(info.value, event)
}
</script>

<template>
  <span
    class="commit-ref"
    :class="{ 'commit-ref-ok': !!info }"
    :role="info ? 'link' : undefined"
    :tabindex="info ? 0 : undefined"
    :title="tip || undefined"
    :data-commit="hash"
    data-test="commit-ref"
    @mouseenter="check"
    @focusin="check"
    @click="onClick"
    @keydown.enter="onKey"
    ><slot>{{ hash }}</slot></span
  >
</template>

<style scoped>
.commit-ref-ok {
  cursor: pointer;
  text-decoration-line: underline;
  text-decoration-style: dotted;
  text-underline-offset: 2px;
}
.commit-ref-ok:hover,
.commit-ref-ok:focus-visible {
  text-decoration-style: solid;
  outline: none;
}
</style>
