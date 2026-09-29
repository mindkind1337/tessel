<script setup>
// After Orca's NativeChatTaskList.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
/**
 * An agent's task list (TodoWrite / update_plan). Inline in a tool run it leads
 * with what changed since the previous list ("Completed Read", "Started
 * Write") and opens the complete checklist on demand; above the composer
 * ('composer') it is a collapsible checklist with its progress.
 * Props: list ({ tasks: [{ content, status, activeForm? }], explanation? }),
 *   previous (the list before, for the diff), presentation 'inline' | 'composer'.
 */
import { computed } from 'vue'
import { ChevronRight, Circle, CircleCheck, CircleDot, ListChecks } from 'lucide-vue-next'
import { t } from '../../../i18n'
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from './ui'
import { diffNativeChatTaskLists, nativeChatTaskLabel } from '../../../chat/orca/shared/native-chat-task-list.js'

const props = defineProps({
  list: { type: Object, required: true },
  previous: { type: Object, default: undefined },
  presentation: { type: String, default: 'inline' }
})

const completed = computed(() => props.list.tasks.filter((task) => task.status === 'completed').length)
const progressLabel = computed(() =>
  t('chat.orca.taskList.progress', '{{completed}} of {{total}} tasks completed', {
    completed: completed.value,
    total: props.list.tasks.length
  })
)
const progressText = computed(() => `${completed.value}/${props.list.tasks.length}`)
const title = computed(() => t('chat.orca.taskList.title', 'Tasks'))
const emptyText = computed(() => t('chat.orca.taskList.empty', 'No tasks'))
const unchangedText = computed(() => t('chat.orca.taskList.unchanged', 'Tasks unchanged'))
const showAllText = computed(() => t('chat.orca.taskList.showAll', 'Full task list'))
const changes = computed(() => (props.previous ? diffNativeChatTaskLists(props.previous, props.list) : null))

function statusLabel(task) {
  if (task.status === 'completed') return t('chat.orca.taskList.completed', 'Completed')
  if (task.status === 'in_progress') return t('chat.orca.taskList.inProgress', 'In progress')
  return t('chat.orca.taskList.pending', 'Pending')
}

function statusIcon(task) {
  return task.status === 'completed' ? CircleCheck : task.status === 'in_progress' ? CircleDot : Circle
}

function changeLabel(change) {
  const values = { task: change.task.content }
  switch (change.kind) {
    case 'added':
      return t('chat.orca.taskList.added', 'Added {{task}}', values)
    case 'removed':
      return t('chat.orca.taskList.removed', 'Removed {{task}}', values)
    case 'started':
      return t('chat.orca.taskList.started', 'Started {{task}}', values)
    case 'completed':
      return t('chat.orca.taskList.finished', 'Completed {{task}}', values)
    case 'pending':
      return t('chat.orca.taskList.reset', 'Marked pending: {{task}}', values)
    default:
      return t('chat.orca.taskList.updated', 'Updated {{task}}', { task: nativeChatTaskLabel(change.task) })
  }
}

// One row shape for the checklist and the change list: a change row carries its
// sentence as the label and is never struck through.
const checklistRows = computed(() =>
  props.list.tasks.map((task, index) => ({ key: `${task.content}:${index}`, task, label: null }))
)
const changeRows = computed(() =>
  (changes.value ?? []).map((change, index) => ({
    key: `${change.kind}:${index}`,
    task: change.task,
    label: changeLabel(change)
  }))
)
</script>

<template>
  <Collapsible v-if="presentation === 'composer'" class="nc-task-list-composer">
    <CollapsibleTrigger class="nc-task-list-composer__trigger">
      <ListChecks aria-hidden="true" class="nc-task-list__list-icon" />
      <span class="nc-task-list-composer__title">{{ title }}</span>
      <span class="nc-task-list__progress" :aria-label="progressLabel">{{ progressText }}</span>
      <ChevronRight aria-hidden="true" class="nc-task-list__chevron" />
    </CollapsibleTrigger>
    <CollapsibleContent>
      <div class="nc-task-list-composer__body nc-scrollbar-sleek">
        <p v-if="list.tasks.length === 0" class="nc-task-list__note">{{ emptyText }}</p>
        <ul v-else :aria-label="title" class="nc-task-list__checklist">
          <li
            v-for="row in checklistRows"
            :key="row.key"
            :class="['nc-task-list__row', { 'nc-task-list__row--active': row.task.status === 'in_progress' }]"
          >
            <component :is="statusIcon(row.task)" aria-hidden="true" class="nc-task-list__status-icon" />
            <span class="nc-task-list__sr-only">{{ statusLabel(row.task) }}: </span>
            <span :class="['nc-task-list__label', { 'nc-task-list__label--done': row.task.status === 'completed' }]">{{
              nativeChatTaskLabel(row.task)
            }}</span>
          </li>
        </ul>
        <p v-if="list.explanation" class="nc-task-list__explanation">{{ list.explanation }}</p>
      </div>
    </CollapsibleContent>
  </Collapsible>
  <div v-else class="nc-task-list">
    <div class="nc-task-list__header">
      <ListChecks aria-hidden="true" class="nc-task-list__list-icon" />
      <span class="nc-task-list__title">{{ title }}</span>
      <span class="nc-task-list__progress" :aria-label="progressLabel">{{ progressText }}</span>
    </div>
    <template v-if="changes">
      <ul v-if="changes.length > 0" class="nc-task-list__checklist">
        <li
          v-for="row in changeRows"
          :key="row.key"
          :class="['nc-task-list__row', { 'nc-task-list__row--active': row.task.status === 'in_progress' }]"
        >
          <component :is="statusIcon(row.task)" aria-hidden="true" class="nc-task-list__status-icon" />
          <span class="nc-task-list__sr-only">{{ statusLabel(row.task) }}: </span>
          <span class="nc-task-list__label">{{ row.label }}</span>
        </li>
      </ul>
      <p v-else class="nc-task-list__note">{{ unchangedText }}</p>
      <Collapsible>
        <CollapsibleTrigger class="nc-task-list__show-all">
          <ChevronRight aria-hidden="true" class="nc-task-list__chevron" />
          {{ showAllText }}
        </CollapsibleTrigger>
        <CollapsibleContent>
          <p v-if="list.tasks.length === 0" class="nc-task-list__note">{{ emptyText }}</p>
          <ul v-else :aria-label="title" class="nc-task-list__checklist">
            <li
              v-for="row in checklistRows"
              :key="row.key"
              :class="['nc-task-list__row', { 'nc-task-list__row--active': row.task.status === 'in_progress' }]"
            >
              <component :is="statusIcon(row.task)" aria-hidden="true" class="nc-task-list__status-icon" />
              <span class="nc-task-list__sr-only">{{ statusLabel(row.task) }}: </span>
              <span :class="['nc-task-list__label', { 'nc-task-list__label--done': row.task.status === 'completed' }]">{{
                nativeChatTaskLabel(row.task)
              }}</span>
            </li>
          </ul>
        </CollapsibleContent>
      </Collapsible>
    </template>
    <template v-else>
      <p v-if="list.tasks.length === 0" class="nc-task-list__note">{{ emptyText }}</p>
      <ul v-else :aria-label="title" class="nc-task-list__checklist">
        <li
          v-for="row in checklistRows"
          :key="row.key"
          :class="['nc-task-list__row', { 'nc-task-list__row--active': row.task.status === 'in_progress' }]"
        >
          <component :is="statusIcon(row.task)" aria-hidden="true" class="nc-task-list__status-icon" />
          <span class="nc-task-list__sr-only">{{ statusLabel(row.task) }}: </span>
          <span :class="['nc-task-list__label', { 'nc-task-list__label--done': row.task.status === 'completed' }]">{{
            nativeChatTaskLabel(row.task)
          }}</span>
        </li>
      </ul>
    </template>
    <p v-if="list.explanation" class="nc-task-list__explanation">{{ list.explanation }}</p>
  </div>
</template>

<style scoped>
/* space-y-1 py-1 */
.nc-task-list {
  padding: 4px 0;
}
.nc-task-list > * + * {
  margin-top: 4px;
}
/* flex items-center gap-1.5 text-xs text-muted-foreground */
.nc-task-list__header {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-task-list__list-icon {
  width: 16px;
  height: 16px;
  flex-shrink: 0;
}
.nc-task-list__title {
  font-weight: 500;
}
.nc-task-list__progress {
  font-variant-numeric: tabular-nums;
}
.nc-task-list__chevron {
  width: 14px;
  height: 14px;
}
[data-state='open'] > .nc-task-list__chevron {
  transform: rotate(90deg);
}
/* space-y-1 py-1 */
.nc-task-list__checklist {
  margin: 0;
  padding: 4px 0;
  list-style: none;
}
.nc-task-list__checklist > * + * {
  margin-top: 4px;
}
/* flex items-start gap-1.5 text-xs text-muted-foreground */
.nc-task-list__row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-task-list__row--active {
  font-weight: 500;
  color: var(--nc-foreground);
}
.nc-task-list__status-icon {
  margin-top: 2px;
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.nc-task-list__label {
  min-width: 0;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.nc-task-list__label--done {
  text-decoration: line-through;
}
.nc-task-list__sr-only {
  position: absolute;
  width: 1px;
  height: 1px;
  padding: 0;
  margin: -1px;
  overflow: hidden;
  clip: rect(0, 0, 0, 0);
  white-space: nowrap;
  border-width: 0;
}
.nc-task-list__note,
.nc-task-list__explanation {
  margin: 0;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
}
.nc-task-list__explanation {
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
/* group flex items-center gap-1 rounded py-0.5 text-xs text-muted-foreground hover:text-foreground */
.nc-task-list__show-all {
  display: flex;
  align-items: center;
  gap: 4px;
  margin: 0;
  padding: 2px 0;
  border: 0;
  border-radius: 4px;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  line-height: 16px;
  color: var(--nc-muted-foreground);
  cursor: pointer;
}
.nc-task-list__show-all:hover {
  color: var(--nc-foreground);
}
.nc-task-list__show-all:focus-visible,
.nc-task-list-composer__trigger:focus-visible {
  outline: none;
  box-shadow: 0 0 0 2px var(--nc-ring);
}
/* rounded-md border border-border bg-muted/30 */
.nc-task-list-composer {
  border: 1px solid var(--nc-border);
  border-radius: 6px;
  background: color-mix(in srgb, var(--nc-muted) 30%, transparent);
}
/* group flex w-full items-center gap-1.5 rounded-md px-3 py-2 text-left text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground */
.nc-task-list-composer__trigger {
  display: flex;
  width: 100%;
  align-items: center;
  gap: 6px;
  margin: 0;
  padding: 8px 12px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  font-family: inherit;
  font-size: 12px;
  line-height: 16px;
  text-align: left;
  color: var(--nc-muted-foreground);
  cursor: pointer;
}
.nc-task-list-composer__trigger:hover {
  background: var(--nc-accent);
  color: var(--nc-accent-foreground);
}
.nc-task-list-composer__title {
  flex: 1 1 0%;
  font-weight: 500;
}
/* max-h-40 overflow-y-auto px-3 pb-2 */
.nc-task-list-composer__body {
  max-height: 160px;
  overflow-y: auto;
  padding: 0 12px 8px;
}
</style>
