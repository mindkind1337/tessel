<script setup>
// A single kanban task. Renders its title + current column and drives the shared
// task-board store directly (the brief: the card consumes the store) — renaming
// it, deleting it, and assigning it to an agent pane. It moves between columns
// by dragging it (TaskBoard takes the drop).
// It only ever reads/writes its own `task`, so a change to one card never forces
// its siblings to re-render.

import { ref, computed, nextTick, inject, watch } from 'vue'
import { updateTask, removeTask, assignAgent, moveTask, tasks as allTasks } from '../taskBoardStore'
import { COLUMNS } from '../../../shared/taskModel'
import BrandIcon from './BrandIcon.vue'
import { formatDuration, formatWhen } from '../timeFormat'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  task: { type: Object, required: true },
  // Agent panes available to assign work to: [{ id, title, agentId, accent }].
  // We store pane.id into task.paneId and label by title (falling back to
  // agentId). Optional so the card renders standalone (e.g. in tests).
  agentPanes: { type: Array, default: () => [] },
  // Picking cards to delete together (Done > Select): a tick box, and a click
  // on the card ticks it.
  selectable: { type: Boolean, default: false },
  selected: { type: Boolean, default: false }
})

const emit = defineEmits(['focus-pane', 'review', 'toggle-select'])

function onCardClick(e) {
  if (!props.selectable) return
  if (e.target.closest && e.target.closest('button, select, input, a')) return
  emit('toggle-select', props.task.id)
}

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
// The agent is chosen while the work is to do or under way; once it waits
// for review or is done, the agent that did it is shown, not changeable (the
// review merges or discards that agent's copy).
const canAssign = computed(() => props.task.column === 'todo' || props.task.column === 'doing')
// "Show agent": while it works on it or waits for review.
const canShowAgent = computed(
  () => !!assignedPane.value && (props.task.column === 'doing' || props.task.column === 'review')
)

// When the work started and was finished: "Started 10:42 · done 11:05 ·
// 23 min" (a date instead of today's time for other days). In To do: when it
// was added (a card from before that was recorded: when it came to To do).
const when = (t) => formatWhen(t)
const addedAt = computed(() => props.task.createdAt || (props.task.column === 'todo' ? props.task.columnSince : null) || null)
const timing = computed(() => {
  const task = props.task
  if (task.column === 'todo') return addedAt.value ? t('tasks.card.added', 'Added {{when}}', { when: when(addedAt.value) }) : ''
  const start = task.startedAt || task.doingSince
  if (task.column === 'done' && task.doneAt) {
    return start
      ? t('tasks.card.startedDone', 'Started {{start}} · done {{done}} · {{duration}}', {
          start: when(start),
          done: when(task.doneAt),
          duration: formatDuration(task.doneAt - start)
        })
      : t('tasks.card.doneAt', 'Done {{when}}', { when: when(task.doneAt) })
  }
  return start ? t('tasks.card.started', 'Started {{when}}', { when: when(start) }) : ''
})
const timingTitle = computed(() => {
  const task = props.task
  const start = task.startedAt || task.doingSince
  const full = (ms) => new Date(ms).toLocaleString(intlLocale())
  const parts = []
  if (addedAt.value) parts.push(t('tasks.card.added', 'Added {{when}}', { when: full(addedAt.value) }))
  if (start) parts.push(t('tasks.card.started', 'Started {{when}}', { when: full(start) }))
  if (task.column === 'done' && task.doneAt) parts.push(t('tasks.card.finished', 'Finished {{when}}', { when: full(task.doneAt) }))
  return parts.join('\n')
})

// --- Orchestration --------------------------------------------------------------
// The cards this one waits for (team_task_add "after"), those not done yet.
// A card deleted from the board still blocks: it shows as removed.
const waitsFor = computed(() =>
  (props.task.deps || [])
    .map((id) => allTasks.find((x) => x.id === id) || { id, title: t('tasks.card.removed', '{{id}} (removed)', { id }), column: 'gone' })
    .filter((x) => x.column !== 'done')
)
const hadDeps = computed(() => (props.task.deps || []).length > 0)
// A decision the agent asked you for (team_task_gate).
const resolveDecision = inject('resolveDecision', null)
const gateDraft = ref('')
function decide(answer) {
  if (resolveDecision) resolveDecision(props.task.id, answer)
  gateDraft.value = ''
}
const reportOpen = ref(false)

const reportLabel = computed(() => {
  const r = props.task.report
  const head = r.outcome === 'succeeded' ? t('tasks.card.report', 'Report') : t('tasks.card.failed', 'Failed')
  const n = (r.files && r.files.length) || 0
  if (!n) return head
  return `${head} · ${t('tasks.card.files', n > 1 ? '{{count}} files' : '{{count}} file', { count: n })}`
})
function onTaskText(onTask) {
  return t('tasks.card.onThisTask', ' · on this task {{time}}', { time: onTask })
}

// Display label for a pane: its title, falling back to the agent id.
function paneLabel(pane) {
  const name = pane.title || pane.agentId || pane.id
  return pane.num ? `#${pane.num} ${name}` : name
}
</script>

<template>
  <div
    class="task-card"
    :class="{ dragging, selectable, selected }"
    data-test="task-card"
    :data-task-id="task.id"
    :data-column="task.column"
    :draggable="!editing"
    tabindex="0"
    :title="t('tasks.card.dragHint', 'Drag to another column (keyboard: Alt+Left / Alt+Right)')"
    aria-keyshortcuts="Alt+ArrowLeft Alt+ArrowRight"
    @keydown="onCardKey"
    @click="onCardClick"
    @dragstart="onDragStart"
    @dragend="dragging = false"
  >
    <!-- Title, then rename (To do only) and delete, always in the same place. -->
    <div class="task-card-top">
      <input
        v-if="selectable"
        type="checkbox"
        class="task-check"
        :checked="selected"
        :aria-label="t('tasks.card.selectTask', 'Select {{title}}', { title: task.title })"
        data-test="task-check"
        @change="emit('toggle-select', task.id)"
      />
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
        :title="canEdit ? t('tasks.card.renameHint', 'Double-click to rename') : null"
        @dblclick="startEdit"
        >{{ task.title }}</span
      >
      <button
        v-if="canEdit && !editing"
        class="task-btn task-icon-btn"
        :title="t('tasks.card.rename', 'Rename task')"
        :aria-label="t('tasks.card.rename', 'Rename task')"
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
      <button
        v-if="!selectable"
        class="task-btn task-icon-btn danger"
        :title="t('tasks.card.delete', 'Delete task')"
        :aria-label="t('tasks.card.delete', 'Delete task')"
        data-test="delete-task"
        @click="onDelete"
      >
        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" />
        </svg>
      </button>
    </div>

    <!-- The agent: chosen in To do and Doing, shown in Review and Done. -->
    <select
      v-if="canAssign"
      v-model="selectedPane"
      class="task-assign"
      :title="t('tasks.card.agentHint', 'The agent doing this task')"
      data-test="assign-select"
    >
      <option value="">{{ t('tasks.card.unassigned', 'Unassigned') }}</option>
      <option v-for="pane in agentPanes" :key="pane.id" :value="pane.id">
        {{ paneLabel(pane) }}
      </option>
    </select>
    <div v-else class="task-card-meta">
      <span
        v-if="assignedPane"
        class="task-assignee"
        data-test="assignee"
        :style="{ '--accent': assignedPane.accent }"
      >
        <BrandIcon :kind="assignedPane.agentId || ''" :size="13" />{{ paneLabel(assignedPane) }}
      </span>
      <span v-else class="task-assignee unassigned" data-test="assignee">{{ t('tasks.card.noAgent', 'No agent') }}</span>
      <span
        v-if="task.column === 'review' && task.leadReview"
        class="task-lead"
        :class="task.leadReview"
        data-test="lead-review"
        :title="task.leadNote || ''"
        >{{ task.leadReview === 'approved' ? t('tasks.card.leadApproved', 'Lead approved') : t('tasks.card.leadReviewing', 'Lead reviewing') }}</span
      >
    </div>

    <div v-if="assignedPane && assignedPane.track && task.column === 'doing'" class="task-track" :class="'track-' + assignedPane.track.level">
      <span>{{ assignedPane.track.text }}<template v-if="assignedPane.track.onTask">{{ onTaskText(assignedPane.track.onTask) }}</template></span>
      <span v-if="assignedPane.track.reason" class="task-track-reason">{{ assignedPane.track.reason }}</span>
    </div>

    <div v-if="hadDeps && task.column !== 'done'" class="task-deps" data-test="task-deps">
      <template v-if="waitsFor.length">
        {{ t('tasks.card.waitsFor', 'Waits for:') }} <span v-for="d in waitsFor" :key="d.id" class="task-dep" :title="d.id">{{ d.title }}</span>
      </template>
      <template v-else>{{ t('tasks.card.ready', 'Ready: the cards it waited for are done') }}</template>
    </div>

    <div v-if="task.gate && task.gate.status === 'pending'" class="task-gate" data-test="task-gate">
      <div class="task-gate-q"><strong>{{ t('tasks.card.yourDecision', 'Your decision:') }}</strong> {{ task.gate.question }}</div>
      <div class="task-gate-options">
        <button v-for="o in task.gate.options || []" :key="o" class="task-btn" @click="decide(o)">{{ o }}</button>
      </div>
      <form class="task-gate-own" @submit.prevent="decide(gateDraft)">
        <input v-model="gateDraft" class="task-gate-input" :placeholder="t('tasks.card.ownAnswerPlaceholder', 'Or your own answer')" :aria-label="t('tasks.card.ownAnswer', 'Your own answer')" />
        <button class="task-btn" type="submit" :disabled="!gateDraft.trim()">{{ t('tasks.card.answer', 'Answer') }}</button>
      </form>
    </div>
    <div v-else-if="task.gate && task.gate.status === 'resolved'" class="task-gate done" :title="task.gate.question">
      {{ t('tasks.card.decided', 'Decided:') }} {{ task.gate.answer }}
    </div>

    <div v-if="task.report" class="task-report" :class="task.report.outcome" data-test="task-report">
      <button class="task-report-head" type="button" :aria-expanded="reportOpen" @click="reportOpen = !reportOpen">
        {{ reportLabel }}
      </button>
      <div v-if="reportOpen" class="task-report-body">
        <p>{{ task.report.summary }}</p>
        <ul v-if="task.report.files && task.report.files.length">
          <li v-for="f in task.report.files" :key="f">{{ f }}</li>
        </ul>
      </div>
    </div>

    <div v-if="task.worktree || task.brief" class="task-card-extra">
      <span v-if="task.worktree" class="task-branch" :title="task.worktree.path">{{ task.worktree.branch }}</span>
      <span v-if="task.brief" class="task-brief" :title="task.brief">{{ task.brief }}</span>
    </div>

    <!-- Bottom line: when, then what can be done now. -->
    <div v-if="timing || canShowAgent || task.column === 'review'" class="task-card-foot">
      <span v-if="timing" class="task-timing" data-test="task-timing" :title="timingTitle">{{ timing }}</span>
      <span class="task-card-actions">
        <button
          v-if="canShowAgent"
          class="task-btn"
          :title="t('tasks.card.showAgentHint', 'Go to the agent doing this task')"
          data-test="show-agent"
          @click="emit('focus-pane', task.paneId)"
        >
          {{ t('tasks.card.showAgent', 'Show agent') }}
        </button>
        <button
          v-if="task.column === 'review'"
          class="task-btn task-review-btn"
          :title="t('tasks.card.reviewHint', 'See the changes, then merge, ask for changes or discard')"
          data-test="review-task"
          @click="emit('review', task.id)"
        >
          {{ t('tasks.card.review', 'Review') }}
        </button>
      </span>
    </div>
  </div>
</template>
