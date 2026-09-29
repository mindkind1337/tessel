<script setup>
// The Tasks panel's orchestration card: each team of this workspace whose
// lead coordinates workers (team_worker_start), like Orca's run view: the
// coordinator's phase (decomposing, dispatching, monitoring, merging, done),
// how many workers run or wait against the limit, and each worker with its
// state and last heartbeat. Here the user allows or refuses a start (Settings
// > Orchestration, "Ask before an agent starts workers"), cancels one that
// waits, stops one that runs (its pane closes the usual way), or goes to it.
// The App provides the data and the actions (inject 'orchestration').
import { computed, inject, ref, onBeforeUnmount } from 'vue'
import { t } from '../i18n'

const props = defineProps({
  workspaceId: { type: String, default: null }
})

const orch = inject('orchestration', null)
const ENDED = ['done', 'failed', 'stopped', 'released', 'refused']
const SHOW_ENDED = 4

const teams = computed(() =>
  ((orch && orch.view && orch.view.value) || []).filter((x) => !props.workspaceId || !x.wsId || x.wsId === props.workspaceId)
)

// Heartbeat ages move on by themselves.
const clock = ref(Date.now())
const timer = setInterval(() => (clock.value = Date.now()), 30000)
onBeforeUnmount(() => clearInterval(timer))

function phaseLabel(p) {
  return (
    {
      decomposing: t('tasks.orch.phase.decomposing', 'Splitting the work'),
      dispatching: t('tasks.orch.phase.dispatching', 'Starting workers'),
      monitoring: t('tasks.orch.phase.monitoring', 'Workers at work'),
      merging: t('tasks.orch.phase.merging', 'To review and merge'),
      done: t('tasks.orch.phase.done', 'Done')
    }[p] || p
  )
}
function statusLabel(s) {
  return (
    {
      confirming: t('tasks.orch.status.confirming', 'Waits for you'),
      queued: t('tasks.orch.status.queued', 'Queued'),
      starting: t('tasks.orch.status.starting', 'Starting'),
      running: t('tasks.orch.status.running', 'Running'),
      done: t('tasks.orch.status.done', 'Done'),
      failed: t('tasks.orch.status.failed', 'Failed'),
      stopped: t('tasks.orch.status.stopped', 'Stopped'),
      released: t('tasks.orch.status.released', 'Released'),
      refused: t('tasks.orch.status.refused', 'Refused')
    }[s] || s
  )
}
function heartbeat(w) {
  if (w.status !== 'running') return ''
  if (!w.heartbeatAt) return t('tasks.orch.noHeartbeat', 'no heartbeat yet')
  const min = Math.max(0, Math.round((clock.value - w.heartbeatAt) / 60000))
  const when = min < 1 ? t('tasks.orch.justNow', 'just now') : t('tasks.orch.minAgo', '{{count}} min ago', { count: min })
  return w.phase ? t('tasks.orch.heartbeatPhase', 'heartbeat {{when}} ({{phase}})', { when, phase: w.phase }) : t('tasks.orch.heartbeat', 'heartbeat {{when}}', { when })
}
function where(w) {
  return w.isolation === 'worktree'
    ? w.branch
      ? t('tasks.orch.ownCopyBranch', 'own copy, {{branch}}', { branch: w.branch })
      : t('tasks.orch.ownCopy', 'own copy')
    : t('tasks.orch.projectFolder', 'project folder')
}
function shown(tm) {
  const live = tm.workers.filter((w) => !ENDED.includes(w.status))
  const ended = tm.workers.filter((w) => ENDED.includes(w.status)).slice(-SHOW_ENDED)
  return [...live, ...ended]
}
function countsLine(tm) {
  return t('tasks.orch.counts', '{{running}} running · {{waiting}} waiting · up to {{max}} at a time per coordinator', {
    running: tm.running,
    waiting: tm.waiting,
    max: tm.limits.maxConcurrent
  })
}
const act = (name, tm, w) => orch && orch[name] && orch[name](tm.teamId, w.id)
const focus = (paneId) => orch && orch.focus && orch.focus(paneId)
</script>

<template>
  <div v-if="teams.length" class="orch-cards">
    <section
      v-for="tm in teams"
      :key="tm.teamId"
      class="orch-card"
      data-test="orch-card"
      :style="{ '--team-color': tm.color }"
      :aria-label="t('tasks.orch.cardLabel', 'Workers of {{team}}', { team: tm.name })"
    >
      <header class="orch-head">
        <span class="orch-dot" aria-hidden="true"></span>
        <span class="orch-team">{{ tm.name }}</span>
        <span class="orch-counts">{{ countsLine(tm) }}</span>
      </header>
      <div v-for="c in tm.coordinators" :key="c.id" class="orch-coord">
        <button type="button" class="orch-link" @click="focus(c.id)">{{ c.label }}</button>
        <span class="orch-phase" :data-phase="c.phase">{{ phaseLabel(c.phase) }}</span>
      </div>
      <ul class="orch-workers">
        <li v-for="w in shown(tm)" :key="w.id" class="orch-worker" :data-status="w.status" data-test="orch-worker">
          <span class="orch-status" :data-status="w.status">{{ statusLabel(w.status) }}</span>
          <span class="orch-title" :title="w.title">{{ w.title }}</span>
          <span class="orch-meta">
            <button v-if="w.paneId" type="button" class="orch-link" @click="focus(w.paneId)">{{ w.label }}</button>
            <span v-else>{{ w.agent }}</span>
            · {{ where(w) }}
            <template v-if="w.model"> · {{ w.model }}</template>
            <template v-if="heartbeat(w)"> · {{ heartbeat(w) }}</template>
            <template v-if="w.reason && ['failed', 'stopped', 'refused'].includes(w.status)"> · {{ w.reason }}</template>
          </span>
          <span class="orch-actions">
            <template v-if="w.status === 'confirming'">
              <button type="button" class="task-head-btn" data-test="orch-allow" @click="act('allow', tm, w)">{{ t('tasks.orch.allow', 'Allow') }}</button>
              <button type="button" class="task-head-btn danger" data-test="orch-refuse" @click="act('refuse', tm, w)">{{ t('tasks.orch.refuse', 'Refuse') }}</button>
            </template>
            <button v-else-if="w.status === 'queued'" type="button" class="task-head-btn" data-test="orch-cancel" @click="act('stop', tm, w)">
              {{ t('tasks.orch.cancel', 'Cancel') }}
            </button>
            <button
              v-else-if="w.status === 'running' || w.status === 'starting'"
              type="button"
              class="task-head-btn danger"
              data-test="orch-stop"
              :disabled="!w.paneId"
              @click="act('stop', tm, w)"
            >
              {{ t('tasks.orch.stop', 'Stop') }}
            </button>
          </span>
        </li>
      </ul>
    </section>
  </div>
</template>
