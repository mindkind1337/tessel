<script setup>
// The Agent Task Board: a 4-column kanban (todo / doing / review / done) rendered
// from the shared reactive store. It owns only the add-task control and the
// column layout; each task is a TaskCard that talks to the store itself. Tasks
// are bucketed once per change (O(n)) and rendered with a stable :key, so a
// single task update re-renders just that card, not the whole board.

import { ref, computed } from 'vue'
import { COLUMNS } from '../../../shared/taskModel'
import { tasks, addTask } from '../taskBoardStore'
import TaskCard from './TaskCard.vue'

const props = defineProps({
  // Agent panes available for assignment, forwarded to every card.
  agentPanes: { type: Array, default: () => [] },
  // Each workspace has its own board: show and add tasks for this one.
  // (null shows every task.)
  workspaceId: { type: String, default: null }
})

const newTitle = ref('')

// One pass over tasks → { todo: [...], doing: [...], ... }. Reads only each
// task's column, so renaming/assigning a task doesn't invalidate the grouping.
const grouped = computed(() => {
  const groups = Object.fromEntries(COLUMNS.map((c) => [c, []]))
  for (const task of tasks) {
    if (props.workspaceId && task.wsId !== props.workspaceId) continue
    if (groups[task.column]) groups[task.column].push(task)
  }
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

function columnLabel(column) {
  return column.charAt(0).toUpperCase() + column.slice(1)
}
</script>

<template>
  <div class="task-board">
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
        data-test="column"
        :data-column="column"
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
          />
          <p v-if="!grouped[column].length" class="task-column-empty">No tasks</p>
        </div>
      </section>
    </div>
  </div>
</template>
