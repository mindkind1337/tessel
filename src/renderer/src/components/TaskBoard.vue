<script setup>
// The Agent Task Board: a 4-column kanban (todo / doing / review / done) rendered
// from the shared reactive store. It owns only the add-task control and the
// column layout; each task is a TaskCard that talks to the store itself. Tasks
// are bucketed once per change (O(n)) and rendered with a stable :key, so a
// single task update re-renders just that card, not the whole board.

import { ref, computed } from 'vue'
import { COLUMNS } from '../../../shared/taskModel'
import { tasks, addTask, moveTask } from '../taskBoardStore'
import TaskCard from './TaskCard.vue'

const props = defineProps({
  // Agent panes available for assignment, forwarded to every card.
  agentPanes: { type: Array, default: () => [] },
  // Each workspace has its own board: show and add tasks for this one.
  // (null shows every task.)
  workspaceId: { type: String, default: null }
})

const emit = defineEmits(['new-task', 'focus-pane', 'review'])
const newTitle = ref('')

// One pass over tasks → { todo: [...], doing: [...], ... }. Reads only each
// task's column, so renaming/assigning a task doesn't invalidate the grouping.
const grouped = computed(() => {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c, []]))
  for (const task of tasks) {
    if (props.workspaceId && task.wsId !== props.workspaceId) continue
    if (groups[task.column]) groups[task.column].push(task)
  }
  // Each column in the order cards arrived in it (Done: the order they were
  // finished), the latest at the bottom. Cards from before this was recorded
  // keep their place at the top.
  for (const c of COLUMNS) groups[c].sort((a, b) => (a.columnSince || 0) - (b.columnSince || 0))
  return groups
})

function onAdd() {
  const title = newTitle.value.trim()
  // Guard before calling the store — createTask throws on an empty title, and a
  // blank submit should simply be a no-op.
  if (!title) return
  addTask({ title, wsId: props.workspaceId })
  newTitle.value = ''
}

// Dropping a dragged card (TaskCard) on a column moves it there.
const TASK_DRAG_TYPE = 'application/x-tessel-task'
// A drag that ends anywhere (dropped elsewhere, Esc) clears it (dragend on
// the board, in the template).
const dropColumn = ref(null)
function isTaskDrag(e) {
  return !!e.dataTransfer && [...e.dataTransfer.types].includes(TASK_DRAG_TYPE)
}
function onDragOver(e, column) {
  if (!isTaskDrag(e)) return
  e.preventDefault()
  e.dataTransfer.dropEffect = 'move'
  dropColumn.value = column
}
function onDragLeave(e, column) {
  // Only when the pointer really leaves the column (not into one of its cards).
  if (dropColumn.value === column && !e.currentTarget.contains(e.relatedTarget)) dropColumn.value = null
}
function onDrop(e, column) {
  dropColumn.value = null
  if (!isTaskDrag(e)) return
  e.preventDefault()
  const id = e.dataTransfer.getData(TASK_DRAG_TYPE)
  const task = tasks.find((t) => t.id === id)
  if (task && task.column !== column) moveTask(id, column)
}

const COLUMN_LABEL = { todo: 'To do', doing: 'Doing', review: 'Review', done: 'Done' }
function columnLabel(column) {
  return COLUMN_LABEL[column] || column
}
</script>

<template>
  <div class="task-board" @dragend="dropColumn = null">
    <div class="task-board-head">
      <button
        class="task-board-new"
        type="button"
        title="Give a task to an agent, in its own copy of the project"
        @click="emit('new-task')"
      >
        New task…
      </button>
    </div>
    <form class="task-board-add" data-test="add-task-form" @submit.prevent="onAdd">
      <input
        v-model="newTitle"
        class="task-board-input"
        type="text"
        placeholder="Add a task…"
        data-test="new-task-input"
      />
      <button class="task-board-add-btn" type="submit">Add</button>
    </form>

    <div class="task-board-columns">
      <section
        v-for="column in COLUMNS"
        :key="column"
        class="task-column"
        :class="{ 'drop-here': dropColumn === column }"
        data-test="column"
        :data-column="column"
        @dragover="(e) => onDragOver(e, column)"
        @dragleave="(e) => onDragLeave(e, column)"
        @drop="(e) => onDrop(e, column)"
      >
        <header class="task-column-head">
          <span class="task-column-title">{{ columnLabel(column) }}</span>
          <span class="task-column-count">{{ grouped[column].length }}</span>
        </header>
        <div class="task-column-body">
          <TaskCard
            v-for="task in grouped[column]"
            :key="task.id"
            :task="task"
            :agent-panes="agentPanes"
            @focus-pane="(id) => emit('focus-pane', id)"
            @review="(id) => emit('review', id)"
          />
          <p v-if="!grouped[column].length" class="task-column-empty">No tasks</p>
        </div>
      </section>
    </div>
  </div>
</template>
