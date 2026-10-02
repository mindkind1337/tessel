<script setup>
// A single kanban task. Renders its title + current column and drives the shared
// task-board store directly (the brief: the card consumes the store) — moving it
// between columns, renaming it, deleting it, and assigning it to an agent pane.
// It only ever reads/writes its own `task`, so a change to one card never forces
// its siblings to re-render.

import { ref, computed, nextTick } from 'vue'
import { COLUMNS } from '../../../shared/taskModel'
import { moveTask, updateTask, removeTask, assignAgent } from '../taskBoardStore'
import BrandIcon from './BrandIcon.vue'

const props = defineProps({
  task: { type: Object, required: true },
  // Agent panes available to assign work to: [{ id, title, agentId, accent }].
  // We store pane.id into task.paneId and label by title (falling back to
  // agentId). Optional so the card renders standalone (e.g. in tests).
  agentPanes: { type: Array, default: () => [] }
})

const colIndex = computed(() => COLUMNS.indexOf(props.task.column))
const canPrev = computed(() => colIndex.value > 0)
const canNext = computed(() => colIndex.value > -1 && colIndex.value < COLUMNS.length - 1)

function movePrev() {
  if (canPrev.value) moveTask(props.task.id, COLUMNS[colIndex.value - 1])
}
function moveNext() {
  if (canNext.value) moveTask(props.task.id, COLUMNS[colIndex.value + 1])
}

// --- Inline title editing (mirrors the pane-title pattern in TerminalPane) ----
const editing = ref(false)
const draft = ref('')
const titleInputEl = ref(null)

function startEdit() {
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

function onDelete() {
  removeTask(props.task.id)
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

// Display label for a pane: its title, falling back to the agent id.
function paneLabel(pane) {
  const name = pane.title || pane.agentId || pane.id
  return pane.num ? `#${pane.num} ${name}` : name
}
</script>

<template>
  <div class="task-card" data-test="task-card">
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
        title="Double-click to rename"
        @dblclick="startEdit"
        >{{ task.title }}</span
      >
      <button class="task-btn" title="Rename task" data-test="edit-title" @click="startEdit">
        edit
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
    </div>

    <div class="task-card-actions">
      <button
        class="task-btn"
        title="Move to previous column"
        data-test="move-prev"
        :disabled="!canPrev"
        @click="movePrev"
      >
        ◀
      </button>
      <button
        class="task-btn"
        title="Move to next column"
        data-test="move-next"
        :disabled="!canNext"
        @click="moveNext"
      >
        ▶
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
