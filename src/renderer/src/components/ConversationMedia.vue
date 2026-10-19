<script setup>
// The Conversations tab's Media view: everything the conversations shown
// share (messageMedia.js mediaItems: the filters' threads, newest first), by
// kind: images and videos as a grid of thumbnails, then web links (title and
// site), files and folders (icon, name, path), code blocks. Each one opens as
// the chat would open it (useMessageLinks.js: the link router, the chat's
// file link checks against the folder of the pane that wrote it), says who
// shared it and when, and "Show in conversation" goes to its message. A long
// list grows as it is scrolled (sections of PAGE items), thumbnails load once
// in view. A commit hash shows its subject once its repository (the
// pane's that wrote it) says it is a commit there, and opens in Source
// Control (CommitRef.vue); one that is not stays text.
import { computed, onBeforeUnmount, onMounted, reactive, ref } from 'vue'
import { Code2, FileText, Film, Folder, GitCommitHorizontal, Globe, ImageIcon, Mail, MessageSquareText } from 'lucide-vue-next'
import MessageThumb from './MessageThumb.vue'
import CommitRef from './CommitRef.vue'
import { commitRootOf } from '../links/commitLinks'
import { useMessageLinks } from '../links/useMessageLinks'
import { formatWhen } from '../timeFormat'
import { t } from '../i18n'

const props = defineProps({
  items: { type: Array, default: () => [] },
  // item -> its file link context (or null).
  contextOf: { type: Function, default: () => null },
  guest: { type: Boolean, default: false },
  loadImage: { type: Function, default: null },
  now: { type: Number, default: () => Date.now() }
})
const emit = defineEmits(['jump'])
const links = useMessageLinks()

const SECTIONS = ['visual', 'link', 'path', 'code', 'commit']
const sectionOf = (item) => (item.type === 'image' || item.type === 'video' ? 'visual' : item.type === 'link' ? 'link' : item.type === 'code' ? 'code' : item.type === 'commit' ? 'commit' : 'path')
const groups = computed(() => {
  const out = Object.fromEntries(SECTIONS.map((s) => [s, []]))
  for (const item of props.items) out[sectionOf(item)].push(item)
  return out
})
const PAGE = { visual: 48, link: 40, path: 40, code: 20, commit: 40 }
const limit = reactive({ ...PAGE })
const shownOf = (s) => groups.value[s].slice(0, limit[s])
const restOf = (s) => Math.max(0, groups.value[s].length - limit[s])
const more = (s) => (limit[s] += PAGE[s])
const sectionTitle = (s) =>
  s === 'visual'
    ? t('conversations.media.visual', 'Images and videos')
    : s === 'link'
      ? t('conversations.media.links', 'Links')
      : s === 'path'
        ? t('conversations.media.paths', 'Files and folders')
        : s === 'commit'
          ? t('conversations.media.commits', 'Commits')
          : t('conversations.media.code', 'Code')
const moreLabel = (s) => t('conversations.media.showMore', 'Show {{count}} more', { count: Math.min(restOf(s), PAGE[s]) })

// The sections grow by themselves as the end of the list comes into view.
const end = ref(null)
let observer = null
onMounted(() => {
  if (typeof IntersectionObserver !== 'function' || !end.value) return
  observer = new IntersectionObserver((list) => {
    if (!list.some((x) => x.isIntersecting)) return
    for (const s of SECTIONS) if (restOf(s)) return void more(s)
  })
  observer.observe(end.value)
})
onBeforeUnmount(() => observer && observer.disconnect())

const when = (at) => formatWhen(at, props.now)
const sharedBy = (item) => t('conversations.media.sharedBy', '{{who}} · {{when}}', { who: item.line.from.label, when: when(item.line.t) })
const showLabel = computed(() => t('conversations.media.show', 'Show in conversation'))

// An image file named in a message: a thumbnail only when it is this
// computer's (an absolute path, never a guest's, never one an agent on an
// SSH host names: that is the host's file).
const ABSOLUTE = /^(?:[A-Za-z]:[\\/]|\/(?!\/))/
function thumbOf(item) {
  if (item.image) return item.image
  if (item.src) return { dataUrl: item.src, name: item.label }
  if (item.path && item.type === 'image' && !props.guest && ABSOLUTE.test(item.path)) {
    const ctx = props.contextOf(item)
    if (ctx && ctx.remote) return null
    return { path: item.path, name: item.label, local: true }
  }
  return null
}
function open(item, event) {
  if (item.type === 'code') return emit('jump', item)
  links.openItem(item, props.contextOf(item), event, { guest: props.guest })
}
const iconOf = (item) => (item.type === 'video' ? Film : item.type === 'folder' ? Folder : item.type === 'link' ? (/^mailto:/i.test(item.url || '') ? Mail : Globe) : item.type === 'code' ? Code2 : item.type === 'image' ? ImageIcon : FileText)
const subOf = (item) => (item.url ? (item.title ? item.site || item.url : item.site && item.url !== item.site ? item.url : '') : item.path && item.path !== item.label ? item.path : item.lang || '')
const tileLabel = (item) => item.title || item.site || item.label
// A commit's repository (its message's pane folder) and its subject once known.
const commitRoot = (item) => (props.guest ? null : commitRootOf(props.contextOf(item)))
const subjects = reactive({})
</script>

<template>
  <div class="cm-media" data-test="cv-media">
    <template v-for="s in SECTIONS" :key="s">
      <section v-if="groups[s].length" class="cm-section" :data-test="'cv-media-' + s">
        <div class="cm-head">
          <span>{{ sectionTitle(s) }}</span>
          <span class="cm-count">{{ groups[s].length }}</span>
        </div>
        <div v-if="s === 'visual'" class="cm-grid">
          <div v-for="item in shownOf(s)" :key="item.key" class="cm-tile" :title="sharedBy(item)" data-test="cv-media-item">
            <MessageThumb v-if="thumbOf(item)" :image="thumbOf(item)" :load="loadImage" :size="92" />
            <button v-else type="button" class="cm-tile-btn" :title="item.url || item.path" @click="open(item, $event)">
              <component :is="iconOf(item)" :size="20" aria-hidden="true" />
              <span class="cm-tile-label">{{ tileLabel(item) }}</span>
            </button>
            <button type="button" class="cm-jump cm-tile-jump" :title="showLabel" :aria-label="showLabel" data-test="cv-media-jump" @click="emit('jump', item)">
              <MessageSquareText :size="12" aria-hidden="true" />
            </button>
            <div class="cm-tile-who">{{ item.line.from.label }}</div>
          </div>
        </div>
        <div v-else class="cm-rows">
          <div v-for="item in shownOf(s)" :key="item.key" class="cm-row" data-test="cv-media-item">
            <div v-if="s === 'commit'" class="cm-row-main cm-row-commit">
              <GitCommitHorizontal :size="14" class="cm-row-icon" aria-hidden="true" />
              <span class="cm-row-text">
                <span class="cm-row-label cm-row-hash">
                  <CommitRef :hash="item.hash" :root="commitRoot(item)" eager @resolved="(info) => (subjects[item.key] = info ? info.subject : '')">{{ item.hash.slice(0, 12) }}</CommitRef>
                </span>
                <span v-if="subjects[item.key]" class="cm-row-sub">{{ subjects[item.key] }}</span>
              </span>
            </div>
            <button v-else type="button" class="cm-row-main" :title="item.url || item.path || item.preview" @click="open(item, $event)">
              <component :is="iconOf(item)" :size="14" class="cm-row-icon" aria-hidden="true" />
              <span class="cm-row-text">
                <span class="cm-row-label">{{ item.type === 'code' ? item.preview || item.lang : item.label }}</span>
                <span v-if="subOf(item)" class="cm-row-sub">{{ subOf(item) }}</span>
              </span>
            </button>
            <span class="cm-row-who">{{ sharedBy(item) }}</span>
            <button type="button" class="cm-jump" :title="showLabel" :aria-label="showLabel" data-test="cv-media-jump" @click="emit('jump', item)">
              <MessageSquareText :size="12" aria-hidden="true" />
            </button>
          </div>
        </div>
        <button v-if="restOf(s)" type="button" class="cm-more" @click="more(s)">{{ moreLabel(s) }}</button>
      </section>
    </template>
    <div ref="end" class="cm-end" aria-hidden="true"></div>
  </div>
</template>

<style scoped>
.cm-media {
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 8px 10px 16px;
}
.cm-head {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-bottom: 6px;
  color: var(--text-dim);
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.cm-count {
  padding: 0 6px;
  border-radius: 8px;
  background: var(--surface-3);
  font-weight: 500;
}
.cm-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(92px, 1fr));
  gap: 8px;
}
.cm-tile {
  position: relative;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 3px;
  min-width: 0;
}
.cm-tile-btn {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: 92px;
  height: 92px;
  padding: 6px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  color: var(--text-dim);
  font: inherit;
  cursor: pointer;
}
.cm-tile-btn:hover {
  color: var(--text-strong);
}
.cm-tile-label {
  display: -webkit-box;
  max-width: 100%;
  overflow: hidden;
  font-size: 10.5px;
  line-height: 13px;
  text-align: center;
  word-break: break-word;
  -webkit-line-clamp: 3;
  -webkit-box-orient: vertical;
}
.cm-tile-who {
  max-width: 92px;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cm-jump {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.cm-jump:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.cm-tile-jump {
  position: absolute;
  top: 3px;
  right: 3px;
  background: color-mix(in srgb, var(--surface) 80%, transparent);
  opacity: 0;
}
.cm-tile:hover .cm-tile-jump,
.cm-tile-jump:focus-visible {
  opacity: 1;
}
.cm-rows {
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.cm-row {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  padding: 2px 4px;
  border-radius: 6px;
}
.cm-row:hover {
  background: var(--surface-2);
}
.cm-row-main {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 3px 0;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.cm-row-icon {
  flex: 0 0 auto;
  color: var(--text-dim);
}
.cm-row-text {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.cm-row-label,
.cm-row-sub {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cm-row-label {
  color: var(--text-strong);
  font-size: 12px;
}
.cm-row-main:hover .cm-row-label {
  text-decoration: underline;
  text-underline-offset: 2px;
}
.cm-row-sub {
  color: var(--text-dim);
  font-size: 10.5px;
}
/* A commit: its hash is the link (CommitRef), not the whole row. */
.cm-row-commit {
  cursor: default;
}
.cm-row-main.cm-row-commit:hover .cm-row-label {
  text-decoration: none;
}
.cm-row-hash {
  font-family: var(--mono, ui-monospace, Consolas, monospace);
}
.cm-row-who {
  flex: 0 1 auto;
  max-width: 40%;
  overflow: hidden;
  color: var(--text-dim);
  font-size: 10.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cm-more {
  align-self: flex-start;
  margin-top: 6px;
  padding: 3px 10px;
  border: 0;
  border-radius: 12px;
  background: var(--surface-3);
  color: var(--text-dim);
  font: inherit;
  font-size: 11px;
  cursor: pointer;
}
.cm-more:hover {
  color: var(--text-strong);
}
.cm-section {
  display: flex;
  flex-direction: column;
}
.cm-end {
  height: 1px;
}
</style>
