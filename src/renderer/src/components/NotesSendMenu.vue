<script setup>
// "Send notes to an agent" (after Orca's NotesSendMenu.tsx and
// ReviewNotesSendMenuContent.tsx, MIT, Copyright (c) 2026 Lovecast Inc.):
// the notes of one scope (this file, all unsent notes, one note) go to an
// agent pane of the workspace in one message. Tessel delivers it the way it
// delivers every message to an agent (App.deliverToAgent): never typed while
// the agent works or waits for an approval, confirmed once the agent takes
// it; the notes are cleared when it is delivered.
import { ref, computed, nextTick, onBeforeUnmount } from 'vue'
import { notesDelivery } from '../notesDelivery'
import LucideIcon from './LucideIcon.vue'
import { t } from '../i18n'

const props = defineProps({
  // [{ id, label, notes, prompt }]
  scopes: { type: Array, required: true },
  defaultScopeId: { type: String, default: '' },
  triggerLabel: { type: String, default: '' },
  triggerCount: { type: Number, default: null },
  actionLabel: { type: String, default: '' },
  triggerClass: { type: String, default: '' },
  disabledTooltip: { type: String, default: '' },
  // (notes) once the agent took them (@delivered). A prop, not an emit: it
  // must still run when this menu is gone by then (a note card closed).
  onDelivered: { type: Function, default: null }
})

const enabledSendTooltip = () => t('notes.send.tooltip', 'Send notes to an agent')
const triggerTitle = computed(() =>
  hasDeliverableNotes.value ? enabledSendTooltip() : props.disabledTooltip || t('notes.send.allSent', 'All notes sent')
)
const triggerAria = computed(() =>
  props.triggerLabel ? t('notes.send.sendLabel', 'Send {{label}} to an agent', { label: props.triggerLabel }) : enabledSendTooltip()
)

const open = ref(false)
const triggerEl = ref(null)
const menuEl = ref(null)
const subEl = ref(null)
const pos = ref({ top: 0, right: 0 })
const sub = ref(null) // { scope, top, right }
const enabledScopes = computed(() => props.scopes.filter((s) => s.notes.length > 0))
const hasDeliverableNotes = computed(() => enabledScopes.value.length > 0)
const single = computed(() => props.scopes.length <= 1)
const targets = ref([])

function place() {
  const r = triggerEl.value && triggerEl.value.getBoundingClientRect()
  if (!r) return
  pos.value = { top: Math.round(r.bottom + 4), right: Math.max(4, Math.round(window.innerWidth - r.right)) }
}

function toggle() {
  if (!hasDeliverableNotes.value) return
  if (open.value) return close()
  const d = notesDelivery()
  targets.value = d ? d.targets() : []
  place()
  open.value = true
  sub.value = null
  nextTick(() => {
    document.addEventListener('mousedown', onOutside, true)
    window.addEventListener('keydown', onKey, true)
  })
}
function close() {
  open.value = false
  sub.value = null
  document.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
}
function onOutside(e) {
  const el = e.target
  if (triggerEl.value && triggerEl.value.contains(el)) return
  if (menuEl.value && menuEl.value.contains(el)) return
  if (subEl.value && subEl.value.contains(el)) return
  close()
}
function openSub(scope, e) {
  if (!scope.notes.length) return
  const r = e.currentTarget.getBoundingClientRect()
  sub.value = { scope, top: Math.round(r.top - 5), right: Math.round(window.innerWidth - r.left + 2) }
}

const singleScope = computed(() => (single.value ? enabledScopes.value[0] || props.scopes[0] : null))

function send(scope, target) {
  const d = notesDelivery()
  if (!d || !scope || !scope.notes.length || target.disabledReason) return
  const notes = scope.notes.slice()
  const done = props.onDelivered
  close()
  d.send(target.id, scope.prompt, {
    onDelivered: () => done && done(notes)
  })
}

function onKey(e) {
  if (e.key === 'Escape' && open.value) {
    e.preventDefault()
    e.stopPropagation()
    close()
  }
}
onBeforeUnmount(() => {
  document.removeEventListener('mousedown', onOutside, true)
  window.removeEventListener('keydown', onKey, true)
})
</script>

<template>
  <span class="nsm">
    <button
      ref="triggerEl"
      type="button"
      class="nsm-trigger"
      :class="triggerClass"
      :disabled="!hasDeliverableNotes"
      :title="triggerTitle"
      :aria-label="triggerAria"
      aria-haspopup="menu"
      :aria-expanded="open"
      data-test="notes-send"
      @mousedown.stop
      @click.stop="toggle"
    >
      <template v-if="triggerLabel">
        <LucideIcon name="sparkles" :size="12" class="nsm-sparkles" />
        <span class="nsm-label">{{ triggerLabel }}</span>
        <span v-if="triggerCount !== null" class="nsm-count">{{ triggerCount }}</span>
        <span class="nsm-sep" aria-hidden="true"></span>
      </template>
      <LucideIcon name="send" :size="triggerLabel ? 12 : 14" />
      <span v-if="actionLabel" class="nsm-label">{{ actionLabel }}</span>
    </button>
    <Teleport to="body">
      <div v-if="open" ref="menuEl" class="ctx-menu nsm-menu" role="menu" :style="{ top: pos.top + 'px', right: pos.right + 'px' }" data-test="notes-send-menu">
        <template v-if="!single">
          <div class="nsm-menu-label">{{ t('notes.send.sendNotes', 'Send notes') }}</div>
          <button
            v-for="s in scopes"
            :key="s.id"
            type="button"
            class="ctx-menu-item nsm-scope"
            :class="{ on: sub && sub.scope.id === s.id }"
            :disabled="!s.notes.length"
            role="menuitem"
            @mouseenter="openSub(s, $event)"
            @focus="openSub(s, $event)"
            @click="openSub(s, $event)"
          >
            <span>{{ s.label }}</span>
            <span class="nsm-scope-count">{{ s.notes.length }}</span>
          </button>
        </template>
        <template v-else>
          <div class="nsm-menu-label">{{ t('notes.send.sendNotesTo', 'Send notes to') }}</div>
          <button
            v-for="tg in targets"
            :key="tg.id"
            type="button"
            class="ctx-menu-item nsm-target"
            role="menuitem"
            :disabled="!!tg.disabledReason"
            :title="tg.disabledReason || tg.hint || ''"
            data-test="notes-send-target"
            @click="send(singleScope, tg)"
          >
            <span class="nsm-target-name">{{ tg.label }}</span>
            <span class="nsm-target-state">{{ tg.disabledReason || tg.stateLabel }}</span>
          </button>
          <div v-if="!targets.length" class="nsm-empty">
            {{ t('notes.send.noAgent', 'No agent open in this workspace. Start one, then send the notes.') }}
          </div>
        </template>
      </div>
      <div
        v-if="open && sub"
        ref="subEl"
        class="ctx-menu nsm-menu nsm-sub"
        role="menu"
        :style="{ top: sub.top + 'px', right: sub.right + 'px' }"
      >
        <div class="nsm-menu-label">{{ t('notes.send.sendNotesTo', 'Send notes to') }}</div>
        <button
          v-for="tg in targets"
          :key="tg.id"
          type="button"
          class="ctx-menu-item nsm-target"
          role="menuitem"
          :disabled="!!tg.disabledReason"
          :title="tg.disabledReason || tg.hint || ''"
          data-test="notes-send-target"
          @click="send(sub.scope, tg)"
        >
          <span class="nsm-target-name">{{ tg.label }}</span>
          <span class="nsm-target-state">{{ tg.disabledReason || tg.stateLabel }}</span>
        </button>
        <div v-if="!targets.length" class="nsm-empty">
          {{ t('notes.send.noAgent', 'No agent open in this workspace. Start one, then send the notes.') }}
        </div>
      </div>
    </Teleport>
  </span>
</template>
