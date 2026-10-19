<script setup>
// A message outside the chat (the Conversations tab, Past conversations,
// a task card's report, the activity log), shown as the chat shows it: its
// Markdown (ChatMarkdown.vue: links, code blocks, lists), its paths as links
// read against the folder of the pane that wrote it (context: a worktree
// copy's when it works in one; none: its paths stay text), the images it
// holds as thumbnails (MessageThumb.vue, their bytes asked for once in view)
// and the files a prompt held as chips. A Live Share guest's (guest): web
// links only, through the host's link filtering; no path is a link there.
import { computed } from 'vue'
import { Paperclip } from 'lucide-vue-next'
import ChatMarkdown from './chat/orca/ChatMarkdown.vue'
import MessageThumb from './MessageThumb.vue'
import { useMessageLinks } from '../links/useMessageLinks'
import { routeNativeChatHref } from '../chat/orca/shared/native-chat-href-routing.js'
import { t } from '../i18n'

const props = defineProps({
  text: { type: String, default: '' },
  // WP3's images contract (terminalConversations.js, sessionDetails.js).
  images: { type: Array, default: () => [] },
  imagesMore: { type: Number, default: 0 },
  // A prompt's other files: [{ name, mediaType?, size?, path? }].
  files: { type: Array, default: () => [] },
  // The file link context (useMessageLinks().contextFor), or null.
  context: { type: Object, default: null },
  guest: { type: Boolean, default: false },
  // image -> Promise<{ ok, dataUrl }> for an image given by its key.
  loadImage: { type: Function, default: null },
  thumbSize: { type: Number, default: 64 }
})

const links = useMessageLinks()
// A guest's link: a web page through the host's filtering, nothing else.
function guestClick(event, href) {
  event.preventDefault()
  const route = routeNativeChatHref(href)
  if (route.kind === 'web' && /^https?:/i.test(route.url)) links.openUrl(route.url, event, true)
}
const linkHandler = computed(() => (props.guest ? guestClick : undefined))
const linkify = computed(() => !props.guest && !!props.context)
const moreText = computed(() => t('conversations.media.moreImages', '+{{count}}', { count: props.imagesMore }))
const moreTitle = computed(() => t('conversations.media.moreImagesHint', '{{count}} more images not shown', { count: props.imagesMore }))
function sizeOf(n) {
  if (!Number.isFinite(n)) return ''
  if (n < 1024) return `${n} B` // i18n-ignore
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} KB` // i18n-ignore
  return `${(n / 1024 / 1024).toFixed(1)} MB` // i18n-ignore
}
function openFile(f, event) {
  event.stopPropagation()
  if (!props.guest && f.path) links.openPath({ path: f.path }, props.context, event)
}
</script>

<template>
  <div class="rm" data-test="rich-message">
    <ChatMarkdown
      v-if="text"
      :content="text"
      variant="document"
      class="rm-md"
      :on-link-click="linkHandler"
      :file-link-context="linkify ? context : null"
      :linkify-file-paths="linkify"
      data-test="rich-text"
    />
    <div v-if="images.length || imagesMore" class="rm-images" data-test="rich-images">
      <MessageThumb v-for="(img, i) in images" :key="img.key || img.path || i" :image="img" :load="loadImage" :size="thumbSize" />
      <span v-if="imagesMore" class="rm-more" :title="moreTitle">{{ moreText }}</span>
    </div>
    <div v-if="files.length" class="rm-files">
      <component
        :is="f.path && !guest ? 'button' : 'span'"
        v-for="(f, i) in files"
        :key="f.path || f.name || i"
        :type="f.path && !guest ? 'button' : null"
        class="rm-file"
        :title="f.path || f.name"
        data-test="rich-file"
        @click="openFile(f, $event)"
      >
        <Paperclip :size="11" aria-hidden="true" />
        <span class="rm-file-name">{{ f.name }}</span>
        <span v-if="sizeOf(f.size)" class="rm-file-size">{{ sizeOf(f.size) }}</span>
      </component>
    </div>
  </div>
</template>

<style scoped>
/* The chat's Markdown tokens, from the surface it sits on (the bubble sets
   its own colors). */
.rm {
  --nc-foreground: currentColor;
  --nc-muted-foreground: var(--text-dim);
  --nc-muted: color-mix(in srgb, currentColor 8%, transparent);
  --nc-accent: color-mix(in srgb, currentColor 12%, transparent);
  --nc-border: color-mix(in srgb, currentColor 22%, transparent);
  --nc-primary: currentColor;
  min-width: 0;
}
.rm-md {
  font-size: inherit;
  line-height: inherit;
}
.rm-md :deep(.cm-d-p) {
  margin: 0 0 6px;
}
.rm-md :deep(.cm-d-p:last-child) {
  margin-bottom: 0;
}
.rm-md :deep(.cm-d-pre) {
  max-height: 260px;
  margin: 4px 0;
  overflow: auto;
  font-size: 11.5px;
}
.rm-md :deep(:is(.cm-d-h1, .cm-d-h2, .cm-d-h3)) {
  margin: 6px 0 4px;
  font-size: 1.05em;
}
.rm-images {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.rm-images:first-child {
  margin-top: 0;
}
.rm-more {
  align-self: center;
  padding: 0 4px;
  font-size: 11px;
  opacity: 0.75;
}
.rm-files {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin-top: 6px;
}
.rm-file {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  padding: 2px 8px;
  border: 1px solid color-mix(in srgb, currentColor 25%, transparent);
  border-radius: 10px;
  background: transparent;
  color: inherit;
  font: inherit;
  font-size: 11px;
}
button.rm-file {
  cursor: pointer;
}
button.rm-file:hover {
  background: color-mix(in srgb, currentColor 10%, transparent);
}
.rm-file-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.rm-file-size {
  opacity: 0.7;
}
</style>
