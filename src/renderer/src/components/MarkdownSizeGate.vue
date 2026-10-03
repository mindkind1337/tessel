<script setup>
// In place of a Markdown preview too large to render at once (markdownSize.js,
// after Orca's MarkdownPreviewSizeGate.tsx; MIT, Copyright (c) 2026 Lovecast
// Inc.): over the gate, "Render anyway"; over the hard cap, only the source.
import { computed } from 'vue'
import { MARKDOWN_PREVIEW_GATE_BYTES, MARKDOWN_PREVIEW_MAX_BYTES } from '../markdownSize'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  // 'gate' | 'too-large' (markdownPreviewState)
  state: { type: String, required: true },
  // Hides "Show source" where the source is already shown under the note.
  sourceButton: { type: Boolean, default: true }
})
const emit = defineEmits(['render', 'source'])

function sizeLabel(n) {
  const num = (v) =>
    new Intl.NumberFormat(intlLocale(), { maximumFractionDigits: 1, useGrouping: false }).format(v)
  if (n < 1024 * 1024) return t('editor.viewer.sizeKb', '{{n}} KB', { n: num(n / 1024) })
  return t('editor.viewer.sizeMb', '{{n}} MB', { n: num(n / 1024 / 1024) })
}

const note = computed(() => {
  if (props.state === 'too-large') {
    const limit = sizeLabel(MARKDOWN_PREVIEW_MAX_BYTES)
    return t('editor.viewer.markdownTooLarge', 'This Markdown file is over {{limit}}, too large to preview: Source shows it as text.', { limit })
  }
  const limit = sizeLabel(MARKDOWN_PREVIEW_GATE_BYTES)
  return t('editor.viewer.markdownLarge', 'Large file: this Markdown file is over {{limit}}, and rendering it can freeze Tessel for a moment.', { limit })
})
</script>

<template>
  <div class="fview-note md-size-gate" data-test="markdown-size-gate" :data-state="state">
    <p>{{ note }}</p>
    <div class="md-size-gate-actions">
      <button v-if="state === 'gate'" type="button" class="imgview-btn" data-test="markdown-render-anyway" @click="emit('render')">
        {{ t('editor.viewer.renderAnyway', 'Render anyway') }}
      </button>
      <button v-if="sourceButton" type="button" class="imgview-btn" data-test="markdown-show-source" @click="emit('source')">
        {{ t('editor.viewer.showSource', 'Show source') }}
      </button>
    </div>
  </div>
</template>

<style scoped>
.md-size-gate {
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 10px;
  text-align: center;
}
.md-size-gate p {
  margin: 0;
  max-width: 520px;
}
.md-size-gate-actions {
  display: flex;
  gap: 8px;
}
</style>
