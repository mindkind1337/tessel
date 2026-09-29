<script setup>
// After Orca's NativeChatToolAnnotations.tsx, NativeChatSearchResults (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * A web search's result links under its opened row. Only safe http(s) URLs
 * survive toolWebSearchResults. Clicks (and middle clicks) go through
 * onLinkClick(event, url), the chat's link router.
 * Tessel: without a router the click is cancelled, so a link never navigates
 * the window.
 * Props: results (the block's webSearchResults), onLinkClick.
 */
import { computed } from 'vue'
import { toolWebSearchResults } from '../../../chat/orca/shared/native-chat-tool-identity.js'

const props = defineProps({
  results: { type: Array, default: undefined },
  onLinkClick: { type: Function, default: undefined }
})

const hits = computed(() => toolWebSearchResults(props.results))

function route(event, url) {
  event.stopPropagation()
  if (props.onLinkClick) props.onLinkClick(event, url)
  else event.preventDefault()
}

function onClick(event, url) {
  route(event, url)
}

function onAuxClick(event, url) {
  if (event.button === 1) route(event, url)
}
</script>

<template>
  <ul v-if="hits.length > 0" class="nc-search-results">
    <li v-for="hit in hits" :key="hit.url" class="nc-search-results__item">
      <a
        :href="hit.url"
        target="_blank"
        rel="noreferrer"
        :title="hit.url"
        class="nc-search-results__link"
        @click="onClick($event, hit.url)"
        @auxclick="onAuxClick($event, hit.url)"
      >
        {{ hit.title }}<span v-if="hit.title !== hit.url" class="nc-search-results__url">{{ hit.url }}</span>
      </a>
    </li>
  </ul>
</template>

<style scoped>
/* ml-5 space-y-0.5 text-xs */
.nc-search-results {
  margin: 0 0 0 20px;
  padding: 0;
  list-style: none;
  font-size: 12px;
  line-height: 16px;
}
.nc-search-results__item + .nc-search-results__item {
  margin-top: 2px;
}
.nc-search-results__item {
  min-width: 0;
}
/* block truncate text-foreground/80 underline underline-offset-2 hover:text-foreground */
.nc-search-results__link {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: color-mix(in srgb, var(--nc-foreground) 80%, transparent);
  text-decoration: underline;
  text-underline-offset: 2px;
}
.nc-search-results__link:hover {
  color: var(--nc-foreground);
}
.nc-search-results__link:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
.nc-search-results__url {
  margin-left: 6px;
  font-size: 11px;
  color: var(--nc-muted-foreground);
}
</style>
