<script setup>
// "Update Available" card, bottom right, ported from Orca's UpdateCard.tsx /
// UpdateAvailableSimpleContent (MIT, Copyright (c) 2026 Lovecast Inc.): the
// version, a line about the sessions, "Release notes", a full-width Update
// button, × to dismiss this version, and Orca's one-time reassurance notice
// above it. Tessel's own update logic stays: the update is downloaded in the
// background (src/main/updater.js) and "Update" opens the restart
// confirmation (UpdateDialog.vue).
//
// Orca keeps terminal sessions running through an update; Tessel restarts and
// reopens its panes, so the wording says that instead.
import { ref, computed, watch } from 'vue'
import { X } from 'lucide-vue-next'
import { t } from '../i18n'

const props = defineProps({
  status: { type: Object, required: true },
  // Where the release notes are (GitHub release of this version).
  releaseUrl: { type: String, default: '' }
})
const emit = defineEmits(['update'])

const DISMISSED_KEY = 'tessel.updateCard.dismissedVersion'
const REASSURED_KEY = 'tessel.updateCard.reassuranceSeen'

function read(key) {
  try {
    return window.localStorage.getItem(key) || ''
  } catch {
    return ''
  }
}
function write(key, value) {
  try {
    window.localStorage.setItem(key, value)
  } catch {
    /* only a convenience */
  }
}

const dismissed = ref(read(DISMISSED_KEY))
const reassuranceSeen = ref(read(REASSURED_KEY) === '1')
const exiting = ref(false)

const version = computed(() => String(props.status.version || ''))
const visible = computed(() => props.status.state === 'ready' && !!version.value && dismissed.value !== version.value)
const readyText = computed(() => t('app.updateCard.ready', 'Tessel v{{version}} is ready.', { version: version.value }))
const showReassurance = computed(() => visible.value && !reassuranceSeen.value)

watch(version, () => (exiting.value = false))

function dismiss() {
  dismissed.value = version.value
  write(DISMISSED_KEY, version.value)
}
function dismissWithAnimation() {
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches
  if (reduce) return dismiss()
  exiting.value = true
  setTimeout(dismiss, 150)
}
function markReassuranceSeen() {
  reassuranceSeen.value = true
  write(REASSURED_KEY, '1')
}
function update() {
  if (!reassuranceSeen.value) markReassuranceSeen()
  emit('update')
}
function openNotes() {
  const api = window.shellApi
  if (api && typeof api.openExternal === 'function' && props.releaseUrl) api.openExternal(props.releaseUrl)
}
function onKeydown(e) {
  if (e.key !== 'Escape') return
  e.preventDefault()
  dismissWithAnimation()
}
</script>

<template>
  <div v-if="visible" class="uc-stack" data-test="update-card">
    <div v-if="showReassurance" class="uc-card uc-tip" :class="{ exiting }">
      <p class="uc-tip-text">
        {{ t('app.updateCard.reassurance', 'Your panes reopen where they were after the update, and Claude and Codex resume their conversations.') }}
      </p>
      <button
        type="button"
        class="uc-close"
        :aria-label="t('app.updateCard.dismissTip', 'Dismiss tip')"
        data-test="update-card-dismiss-tip"
        @click="markReassuranceSeen"
      >
        <X :size="14" aria-hidden="true" />
      </button>
    </div>
    <div
      class="uc-card"
      :class="{ exiting }"
      role="complementary"
      :aria-label="t('app.updateCard.title', 'Update Available')"
      aria-live="polite"
      tabindex="-1"
      @keydown="onKeydown"
    >
      <div class="uc-body">
        <div class="uc-head">
          <h3 class="uc-title">{{ t('app.updateCard.title', 'Update Available') }}</h3>
          <button
            type="button"
            class="uc-close uc-close-main"
            :aria-label="t('app.updateCard.dismiss', 'Dismiss update')"
            data-test="update-card-dismiss"
            @click="dismissWithAnimation"
          >
            <X :size="14" aria-hidden="true" />
          </button>
        </div>
        <p class="uc-text">{{ readyText }}</p>
        <p class="uc-note">{{ t('app.updateCard.sessions', 'Your panes reopen where they were.') }}</p>
        <button v-if="releaseUrl" type="button" class="uc-link" data-test="update-card-notes" @click="openNotes">
          {{ t('app.updateCard.releaseNotes', 'Release notes') }}
        </button>
        <button type="button" class="uc-update" data-test="update-card-update" @click="update">
          {{ t('app.updateCard.update', 'Update') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.uc-stack {
  display: flex;
  width: 360px;
  max-width: calc(100vw - 32px);
  flex-direction: column;
  gap: 8px;
  pointer-events: auto;
}
.uc-card {
  border: 1px solid var(--border);
  border-radius: 12px;
  background: var(--surface);
  color: var(--text);
  box-shadow: 0 1px 3px rgb(0 0 0 / 0.2), 0 12px 30px rgb(0 0 0 / 0.35);
  animation: uc-enter 0.18s ease-out;
  outline: none;
}
.uc-card.exiting {
  animation: uc-exit 0.15s ease-in forwards;
}
.uc-tip {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 12px;
}
.uc-tip-text {
  flex: 1 1 auto;
  min-width: 0;
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
}
.uc-body {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 14px;
}
.uc-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
}
.uc-title {
  margin: 0;
  color: var(--text-strong);
  font-size: 14px;
  font-weight: 600;
}
.uc-close {
  display: inline-flex;
  width: 28px;
  height: 28px;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text-dim);
  cursor: pointer;
}
.uc-close-main {
  margin: -6px -6px 0 0;
}
.uc-close:hover {
  background: var(--surface-3);
  color: var(--text-strong);
}
.uc-text {
  margin: 0;
  color: var(--text-dim);
  font-size: 14px;
}
.uc-note {
  margin: 0;
  color: var(--text-dim);
  font-size: 12px;
  line-height: 1.6;
}
.uc-link {
  align-self: flex-start;
  padding: 0;
  border: 0;
  background: none;
  color: var(--text-dim);
  font: inherit;
  font-size: 12px;
  text-decoration: underline;
  text-underline-offset: 2px;
  cursor: pointer;
}
.uc-link:hover {
  color: var(--text-strong);
}
.uc-update {
  width: 100%;
  height: 32px;
  margin-top: 2px;
  border: 0;
  border-radius: 6px;
  background: var(--text-strong);
  color: var(--surface);
  font: inherit;
  font-size: 13px;
  font-weight: 500;
  cursor: pointer;
}
.uc-update:hover {
  opacity: 0.9;
}
@keyframes uc-enter {
  from {
    opacity: 0;
    transform: translateY(8px);
  }
}
@keyframes uc-exit {
  to {
    opacity: 0;
    transform: translateY(8px);
  }
}
@media (prefers-reduced-motion: reduce) {
  .uc-card,
  .uc-card.exiting {
    animation: none;
  }
}
</style>
