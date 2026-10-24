<script setup>
// "Change Project Folder…" on a project of an SSH host: the host's folders
// (RemoteFolderBrowser, through the host's signed-in session) and the
// answer of the check App.vue makes on the folder chosen (busy, error).
import { onMounted, onBeforeUnmount } from 'vue'
import { t } from '../../i18n'
import RemoteFolderBrowser from './RemoteFolderBrowser.vue'

const props = defineProps({
  hostId: { type: String, required: true },
  hostLabel: { type: String, default: '' },
  projectName: { type: String, default: '' },
  initialPath: { type: String, default: '~' },
  busy: { type: Boolean, default: false },
  error: { type: String, default: '' }
})
const emit = defineEmits(['select', 'close'])

// (Mustaches cannot sit inside a template expression.)
const titleText = () => t('project.remote.folder.title', 'Project folder on {{host}}', { host: props.hostLabel || props.hostId })
const descText = () =>
  t('project.remote.folder.description', 'New panes of "{{name}}" start in the folder you choose. Panes already open stay where they are, and files open under the old folder will no longer be saved or listed.', { name: props.projectName })

function onKey(e) {
  if (e.key === 'Escape') {
    e.stopPropagation()
    emit('close')
  }
}
onMounted(() => window.addEventListener('keydown', onKey, true))
onBeforeUnmount(() => window.removeEventListener('keydown', onKey, true))
</script>

<template>
  <div class="ap-backdrop" @pointerdown.self="emit('close')">
    <div class="ap-dialog" role="dialog" aria-modal="true" aria-labelledby="rfd-heading" data-test="remote-folder-dialog">
      <header class="ap-head">
        <h2 id="rfd-heading" class="ap-title">{{ titleText() }}</h2>
        <p class="ap-desc">
          {{ descText() }}
        </p>
      </header>
      <RemoteFolderBrowser :host-id="hostId" :initial-path="initialPath" purpose="folder" @select="(p) => !busy && emit('select', p)" @cancel="emit('close')" />
      <p v-if="busy" class="ap-desc" data-test="remote-folder-busy">{{ t('project.remote.folder.checking', 'Checking the folder on the host…') }}</p>
      <p v-else-if="error" class="ap-error" role="alert" data-test="remote-folder-error">{{ error }}</p>
    </div>
  </div>
</template>
