<script setup>
// Live Share, as a guest: one of the host's browser pages whose address only
// works on the host's side (localhost, a private address, a .local name:
// the host's dev server, say). The host's pages are links you open in your
// own browser (liveShareWindowFeeds.js); this one can't open here, so its
// tab says so, calmly, with its address to copy. Nothing of the host's page
// comes (no picture, no input).
// As on the host's screen, the page is a tab of its own above the panes
// (paneViews.js isTabLeaf): its header is then the line of tabs.
import { computed, inject, ref } from 'vue'
import { Copy, Globe } from 'lucide-vue-next'
import { t } from '../i18n'
import ViewTabs from './ViewTabs.vue'

const props = defineProps({ node: { type: Object, required: true } })
const ctx = inject('panelCtx')

const note = computed(() => (ctx.liveSharePageNote ? ctx.liveSharePageNote(props.node.id) : null))
const host = computed(() => (note.value && note.value.host) || (props.node.liveShare && props.node.liveShare.host) || '?')
const url = computed(() => (note.value && note.value.url) || '')
const title = computed(() => (note.value && note.value.title) || t('liveShare.page.title', 'Browser page'))
const isActive = computed(() => !!ctx.activeId && ctx.activeId.value === props.node.id)
const isMaximized = computed(() => !!ctx.maximizedId && ctx.maximizedId.value === props.node.id)
// The tabs above the panes, while this page is one of them (App.vue).
const viewTabs = computed(() => (ctx.paneTabs ? ctx.paneTabs(props.node.id) : null))
const text = computed(() => (note.value && note.value.ended ? t('liveShare.access.ended', 'The Live Share session ended.') : t('liveShare.page.localNote', 'This page runs on {{host}}’s computer: it can’t open here.', { host: host.value })))

const copied = ref(false)
let copiedTimer = 0
async function copyUrl() {
  if (!url.value) return
  try {
    await navigator.clipboard.writeText(url.value)
    copied.value = true
    clearTimeout(copiedTimer)
    copiedTimer = setTimeout(() => (copied.value = false), 2000)
  } catch {
    // No clipboard: the address stays selectable.
  }
}
function activate() {
  if (ctx.setActive) ctx.setActive(props.node.id)
}
</script>

<template>
  <div
    class="pane ls-page-pane"
    :class="{ active: isActive, maximized: isMaximized, highlighted: ctx.highlightId && ctx.highlightId.value === node.id }"
    :data-pane-id="node.id"
    data-pane-kind="liveshare-page"
    data-test="liveshare-page"
    tabindex="0"
    @mousedown="activate"
  >
    <div class="pane-nav" :class="{ 'with-view-tabs': !!viewTabs }" data-test="pane-header">
      <div class="pane-nav-left">
        <ViewTabs
          v-if="viewTabs"
          :leaves="viewTabs.leaves"
          :shown="viewTabs.shown"
          @select="(id, path) => ctx.selectViewTab && ctx.selectViewTab(node.id, id, path)"
          @close="(id, path) => (ctx.closeViewTab ? ctx.closeViewTab(id, path) : ctx.closeLeaf(id))"
          @keep="(id, path) => ctx.keepViewTab && ctx.keepViewTab(id, path)"
          @drag="(id, e) => id && ctx.beginPaneDrag && ctx.beginPaneDrag(id, e)"
        />
        <template v-else>
          <span class="pane-icon" :aria-label="t('liveShare.page.title', 'Browser page')"><Globe :size="15" aria-hidden="true" /></span>
          <span class="pane-title" data-test="pane-title" :title="title">{{ title }}</span>
        </template>
      </div>
    </div>
    <div class="ls-page-body">
      <div class="ls-guest-note" role="status" data-test="liveshare-page-note">
        <p>{{ text }}</p>
        <div v-if="url" class="ls-page-address">
          <code class="ls-page-url" data-test="liveshare-page-url">{{ url }}</code>
          <button type="button" class="ls-page-copy" data-test="liveshare-page-copy" :title="t('liveShare.page.copyUrl', 'Copy the address')" :aria-label="t('liveShare.page.copyUrl', 'Copy the address')" @click="copyUrl">
            <Copy :size="13" aria-hidden="true" />
            <span>{{ copied ? t('liveShare.page.copied', 'Copied') : t('liveShare.page.copy', 'Copy') }}</span>
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.ls-page-pane {
  outline: none;
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
}
.ls-page-body {
  position: relative;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  overflow: auto;
  background: var(--term);
}
.ls-page-address {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 10px;
  max-width: 100%;
}
.ls-page-url {
  min-width: 0;
  padding: 4px 8px;
  border-radius: 4px;
  background: var(--surface-2);
  color: var(--text);
  font-size: 12px;
  user-select: text;
  overflow-wrap: anywhere;
}
.ls-page-copy {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  flex: none;
  padding: 3px 8px;
  border: 1px solid var(--border);
  border-radius: 4px;
  background: var(--surface);
  color: var(--text);
  font-size: 12px;
  cursor: pointer;
}
.ls-page-copy:hover {
  background: var(--surface-2);
}
</style>
