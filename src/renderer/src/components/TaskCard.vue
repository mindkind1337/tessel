<script setup>
// A single kanban task. Renders its title + current column and drives the shared
// task-board store directly (the brief: the card consumes the store) — renaming
// it, deleting it, and assigning it to an agent pane. It moves between columns
// by dragging it (TaskBoard takes the drop).
// It only ever reads/writes its own `task`, so a change to one card never forces
// its siblings to re-render.

import { ref, computed, nextTick, inject, watch } from 'vue'
import { updateTask, removeTask, assignAgent, moveTask } from '../taskBoardStore'
import { COLUMNS } from '../../../shared/taskModel'
import BrandIcon from './BrandIcon.vue'
import { formatDuration } from '../../../shared/activity'

const props = defineProps({
  task: { type: Object, required: true },
  // Agent panes available to assign work to: [{ id, title, agentId, accent }].
  // We store pane.id into task.paneId and label by title (falling back to
  // agentId). Optional so the card renders standalone (e.g. in tests).
  agentPanes: { type: Array, default: () => [] }
})

const emit = defineEmits(['focus-pane', 'review'])

// Drag a card to another column (the only way to move it).
const TASK_DRAG_TYPE = 'application/x-tessel-task' // same type in TaskBoard.vue
const dragging = ref(false)
function onDragStart(e) {
  // Not from its controls (the agent menu, the buttons, the title being
  // edited): those keep working normally.
  const fromControl = e.target && e.target.closest && e.target.closest('select, input, button, textarea')
  if (editing.value || fromControl || !e.dataTransfer) return e.preventDefault()
  e.dataTransfer.setData(TASK_DRAG_TYPE, props.task.id)
  e.dataTransfer.effectAllowed = 'move'
  dragging.value = true
}


// --- Inline title editing (mirrors the pane-title pattern in TerminalPane) ----
const editing = ref(false)
const draft = ref('')
const titleInputEl = ref(null)
// Only a task not started yet (To do) is renamed: once an agent works on it,
// its title is what the agent was given.
const canEdit = computed(() => props.task.column === 'todo')
// It left To do while being renamed: the edit is dropped.
watch(canEdit, (ok) => {
  if (!ok) editing.value = false
})

function startEdit() {
  if (!canEdit.value) return
  draft.value = props.task.title
  editing.value = true
  nextTick(() => titleInputEl.value && titleInputEl.value.select())
}

function saveTitle() {
  if (!editing.value) return
  const next = draft.value.trim()
  // Blank title is rejected rather than silently wiping the task name.
  if (next) updateTask(props.task.id, { title: next })
  editing.value = false
}

function cancelEdit() {
  editing.value = false
}

// Keyboard: Alt+Left / Alt+Right move the focused card one column.
function onCardKey(e) {
  if (!e.altKey || e.ctrlKey || e.shiftKey || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return
  if (e.target !== e.currentTarget) return // typing in its title or menu
  e.preventDefault()
  e.stopPropagation()
  const i = COLUMNS.indexOf(props.task.column)
  const j = i + (e.key === 'ArrowRight' ? 1 : -1)
  if (i < 0 || j < 0 || j >= COLUMNS.length) return
  moveTask(props.task.id, COLUMNS[j])
  nextTick(() => {
    // It moved to another column (a new card element): keep the focus on it.
    const el = document.querySelector(`[data-task-id="${props.task.id}"]`)
    if (el) el.focus()
  })
}

// The app asks first (and cleans up the task's copy); alone (tests), direct.
const deleteTask = inject('deleteTask', null)
function onDelete() {
  if (deleteTask) deleteTask(props.task.id)
  else removeTask(props.task.id)
}

// --- Agent assignment --------------------------------------------------------
// <select> value is a string ('' = unassigned); map it back to a paneId or null.
const selectedPane = computed({
  get: () => props.task.paneId || '',
  set: (value) => assignAgent(props.task.id, value || null)
})

const assignedPane = computed(
  () => props.agentPanes.find((p) => p.id === props.task.paneId) || null
)

// When the work started and was finished: "Started 10:42 · done 11:05 ·
// 23 min" (a date instead of today's time for other days).
function when(t) {
  const d = new Date(t)
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  if (d.toDateString() === new Date().toDateString()) return time
  return `${d.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`
}
const timing = computed(() => {
  const t = props.task
  const start = t.startedAt || t.doingSince
  if (t.column === 'done' && t.doneAt) {
    return start ? `Started ${when(start)} · done ${when(t.doneAt)} · ${formatDuration(t.doneAt - start)}` : `Done ${when(t.doneAt)}`
  }
  return start ? `Started ${when(start)}` : ''
})
const timingTitle = computed(() => {
  const t = props.task
  const start = t.startedAt || t.doingSince
  const parts = []
  if (start) parts.push(`Started ${new Date(start).toLocaleString()}`)
  if (t.column === 'done' && t.doneAt) parts.push(`Finished ${new Date(t.doneAt).toLocaleString()}`)
  return parts.join('\n')
})

// Display label for a pane: its title, falling back to the agent id.
function paneLabel(pane) {
  const name = pane.title || pane.agentId || pane.id
  return pane.num ? `#${pane.num} ${name}` : name
}
</script>

<template>
  <div
    class="task-card"
    :class="{ dragging }"
    data-test="task-card"
    :data-task-id="task.id"
    :draggable="!editing"
    tabindex="0"
    title="Drag to another column (keyboard: Alt+Left / Alt+Right)"
    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
    @keydown="onCardKey"
    @dragstart="onDragStart"
    @dragend="dragging = false"
  >
    <div class="task-card-top">
      <input
        v-if="editing"
        ref="titleInputEl"
        v-model="draft"
        class="task-title-input"
        data-test="title-input"
        @blur="saveTitle"
        @keydown.enter.prevent="saveTitle"
        @keydown.escape.prevent="cancelEdit"
      />
      <span
        v-else
        class="task-title"
        data-test="card-title"
        :title="canEdit ? 'Double-click to rename' : null"
        @dblclick="startEdit"
        >{{ task.title }}</span
      >
      <button
        v-if="canEdit"
        class="task-btn task-edit-btn"
        title="Rename task"
        aria-label="Rename task"
        data-test="edit-title"
        @click="startEdit"
      >
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M11.1 2.6a1.5 1.5 0 0 1 2.1 0l.2.2a1.5 1.5 0 0 1 0 2.1L6 12.3 2.8 13.2l.9-3.2 7.4-7.4Z"
            stroke="currentColor"
            stroke-width="1.3"
            stroke-linejoin="round"
          />
          <path d="M9.8 3.9l2.3 2.3" stroke="currentColor" stroke-width="1.3" />
        </svg>
      </button>
    </div>

    <div class="task-card-meta">
      <span class="task-status" :class="`status-${task.column}`" data-test="card-status">{{
        task.column
      }}</span>
      <span
        v-if="assignedPane"
        class="task-assignee"
        data-test="assignee"
        :style="{ '--accent': assignedPane.accent }"
      >
        <BrandIcon :kind="assignedPane.agentId || ''" :size="13" />{{ paneLabel(assignedPane) }}
      </span>
      <span v-else class="task-assignee unassigned" data-test="assignee">Unassigned</span>
      <span
        v-if="task.column === 'review' && task.leadReview"
        class="task-lead"
        :class="task.leadReview"
        data-test="lead-review"
        :title="task.leadNote || ''"
        >{{ task.leadReview === 'approved' ? 'Lead approved' : 'Lead reviewing' }}</span
      >
    </div>

    <div v-if="assignedPane && assignedPane.track && task.column === 'doing'" class="task-track" :class="'track-' + assignedPane.track.level">
      <span>{{ assignedPane.track.text }}<template v-if="assignedPane.track.onTask"> · on this task {{ assignedPane.track.onTask }}</template></span>
      <span v-if="assignedPane.track.reason" class="task-track-reason">{{ assignedPane.track.reason }}</span>
    </div>

    <div v-if="timing" class="task-timing" data-test="task-timing" :title="timingTitle">{{ timing }}</div>

    <div v-if="task.worktree || task.brief" class="task-card-extra">
      <span v-if="task.worktree" class="task-branch" :title="task.worktree.path">{{ task.worktree.branch }}</span>
      <span v-if="task.brief" class="task-brief" :title="task.brief">{{ task.brief }}</span>
    </div>

    <div class="task-card-actions">
      <button
        v-if="task.column === 'review'"
        class="task-btn task-review-btn"
        title="See the changes, then merge, ask for changes or discard"
        data-test="review-task"
        @click="emit('review', task.id)"
      >
        Review
      </button>
      <button
        v-if="assignedPane && (task.column === 'doing' || task.column === 'review')"
        class="task-btn"
        title="Go to the agent doing this task"
        @click="emit('focus-pane', task.paneId)"
      >
        Show agent
      </button>
      <select
        v-model="selectedPane"
        class="task-assign"
        title="Assign to an agent pane"
        data-test="assign-select"
      >
        <option value="">Unassigned</option>
        <option v-for="pane in agentPanes" :key="pane.id" :value="pane.id">
          {{ paneLabel(pane) }}
        </option>
      </select>

      <button class="task-btn danger" title="Delete task" data-test="delete-task" @click="onDelete">
        ✕
      </button>
    </div>
  </div>
</template>
