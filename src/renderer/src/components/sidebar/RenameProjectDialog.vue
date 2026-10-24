<script setup>
// Rename a project from a small dialog: where its name is not on screen to
// edit in place (the flat list has no project rows). Same cleaning as the
// inline edit and Add a project (projectFolder.js cleanProjectName); two
// projects may share a name. Enter saves, Esc closes.
import { ref, computed, onMounted, onUnmounted } from 'vue'
import { t } from '../../i18n'
import { cleanProjectName } from '../../projectFolder'

const props = defineProps({ name: { type: String, default: '' } })
const emit = defineEmits(['save', 'close'])

const draft = ref(props.name)
const hint = ref('')
const inputEl = ref(null)
const dialog = ref(null)
let previousFocus = null
const MAX = 80
const cleaned = computed(() => cleanProjectName(draft.value))

onMounted(() => {
  previousFocus = document.activeElement
  inputEl.value?.focus()
  inputEl.value?.select()
})
onUnmounted(() => {
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
})

function save() {
  if (!cleaned.value) {
    hint.value = t('sidebar.renameDialog.empty', 'Enter a name for this project.')
    inputEl.value?.focus()
    return
  }
  emit('save', cleaned.value)
}

function trapTab(event) {
  const focusable = [...(dialog.value?.querySelectorAll('button:not(:disabled), input') || [])]
  const first = focusable[0]
  const last = focusable.at(-1)
  if (!first) return
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}
</script>

<template>
  <div class="help-backdrop confirm-backdrop" data-test="rename-project-dialog" @pointerdown.self="emit('close')">
    <div
      ref="dialog"
      class="help-card confirm-card"
      role="dialog"
      aria-modal="true"
      aria-labelledby="rnp-title"
      @focusin.stop
      @keydown.escape.prevent.stop="emit('close')"
      @keydown.tab.stop="trapTab"
    >
      <h2 id="rnp-title" class="confirm-title" v-text="t('sidebar.renameDialog.title', 'Rename project')"></h2>
      <input
        ref="inputEl"
        v-model="draft"
        class="rnp-input"
        type="text"
        data-test="rename-project-input"
        :maxlength="MAX * 2"
        :aria-label="t('sidebar.renameDialog.label', 'Project name')"
        :aria-invalid="hint ? 'true' : 'false'"
        spellcheck="false"
        autocomplete="off"
        @input="hint = ''"
        @keydown.enter.prevent.stop="save"
      />
      <p v-if="hint" class="rnp-hint" role="alert" data-test="rename-project-hint">{{ hint }}</p>
      <div class="confirm-actions">
        <button type="button" class="confirm-btn" data-test="rename-project-cancel" @click="emit('close')">
          {{ t('sidebar.renameDialog.cancel', 'Cancel') }}
        </button>
        <button type="button" class="confirm-btn primary" data-test="rename-project-save" @click="save">
          {{ t('sidebar.renameDialog.save', 'Save') }}
        </button>
      </div>
    </div>
  </div>
</template>
