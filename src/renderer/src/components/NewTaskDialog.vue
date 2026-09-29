<script setup>
// "New task": a title, instructions and the agent that does it. By default a
// new agent works in its own copy of the project (git worktree + branch), so
// it cannot break the running app or another agent's work. App starts it.
import { ref, computed, onMounted, nextTick } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t } from '../i18n'

const props = defineProps({
  wsName: { type: String, default: '' },
  cwd: { type: String, default: '' },
  // Agent kinds that can be started: [{ id, name, accent }]
  agentKinds: { type: Array, default: () => [] },
  // Agents already open in this workspace: [{ id, num, title, agentId, accent,
  //   state, reset }] (state as in the sidebar: 'working', 'limited'...)
  openAgents: { type: Array, default: () => [] },
  // Can a new agent get its own copy? { available, reason, checking }
  isolation: { type: Object, default: () => ({ available: false, reason: null }) }
})
const emit = defineEmits(['start', 'close'])

const title = ref('')
const brief = ref('')
// 'new:<kind id>' or 'pane:<pane id>'
const who = ref(props.agentKinds[0] ? `new:${props.agentKinds[0].id}` : '') // i18n-ignore
const isolated = ref(true)
// Its own copy: from which branch, with the project's .env files, and its
// setup script (.tessel/setup.ps1) run first.
const baseBranch = ref('')
const copyEnv = ref(true)
const runSetup = ref(false)
const reviewerId = ref('')
const titleEl = ref(null)

const isNew = computed(() => who.value.startsWith('new:'))
const canIsolate = computed(() => isNew.value && props.isolation.available)
const reviewers = computed(() =>
  props.openAgents.filter((a) => `pane:${a.id}` !== who.value && a.state !== 'limited' && !a.task) // i18n-ignore
)
const ready = computed(() => title.value.trim() && who.value)

// An open agent that is on a task, working, waiting or out of usage cannot
// take a new one.
function taken(a) {
  return !!a.task || ['working', 'approval', 'limited'].includes(a.state)
}

function stateLabel(a) {
  if (a.task) return t('tasks.new.busyOn', 'Busy: {{task}}', { task: a.task })
  if (a.state === 'limited')
    return a.reset
      ? t('tasks.new.usageLimitReset', 'Usage limit · {{reset}}', { reset: a.reset })
      : t('tasks.new.usageLimit', 'Usage limit')
  if (a.state === 'working') return t('tasks.new.busy', 'Busy')
  if (a.state === 'approval') return t('tasks.new.waitingApproval', 'Waiting for your approval')
  return t('tasks.new.free', 'Free')
}

function inWorkspace() {
  return t('tasks.new.inWorkspace', 'In {{name}}', { name: props.wsName })
}
function newAgentName(name) {
  return t('tasks.new.newAgent', 'New {{name}}', { name })
}
function alreadyOpen(a) {
  return t('tasks.new.alreadyOpen', 'Already open · {{state}}', { state: stateLabel(a) })
}

function start() {
  if (!ready.value) return
  const [kind, id] = [who.value.slice(0, who.value.indexOf(':')), who.value.slice(who.value.indexOf(':') + 1)]
  emit('start', {
    title: title.value.trim(),
    brief: brief.value.trim(),
    agent: { kind, id },
    isolated: kind === 'new' && canIsolate.value && isolated.value,
    worktreeOptions: {
      ...(baseBranch.value.trim() ? { baseBranch: baseBranch.value.trim() } : {}),
      copyEnv: copyEnv.value,
      runSetup: runSetup.value
    },
    reviewerId: reviewerId.value || null
  })
}

onMounted(() => nextTick(() => titleEl.value && titleEl.value.focus()))
</script>

<template>
  <div class="nt-backdrop" @pointerdown.self="emit('close')">
    <form
      class="nt-dialog"
      role="dialog"
      aria-labelledby="nt-heading"
      @submit.prevent="start"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <header class="nt-head">
        <h2 id="nt-heading">{{ t('tasks.new.heading', 'New task') }}</h2>
        <p>{{ inWorkspace() }}<span v-if="cwd"> · {{ cwd }}</span></p>
      </header>

      <label class="nt-label" for="nt-title">{{ t('tasks.new.title', 'Title') }}</label>
      <input
        id="nt-title"
        ref="titleEl"
        v-model="title"
        class="nt-input"
        maxlength="120"
        :placeholder="t('tasks.new.titlePlaceholder', 'What should be done')"
      />

      <label class="nt-label" for="nt-brief">{{ t('tasks.new.brief', 'Instructions for the agent') }}</label>
      <textarea
        id="nt-brief"
        v-model="brief"
        class="nt-input nt-brief"
        rows="4"
        :placeholder="t('tasks.new.briefPlaceholder', 'Details, files to touch or leave alone, how to check it works…')"
      ></textarea>

      <span class="nt-label">{{ t('tasks.new.agent', 'Agent') }}</span>
      <div class="nt-agents">
        <label
          v-for="k in agentKinds"
          :key="'new:' + k.id"
          class="nt-agent"
          :class="{ on: who === 'new:' + k.id }"
        >
          <input v-model="who" type="radio" name="nt-who" :value="'new:' + k.id" />
          <BrandIcon :kind="k.id" :accent="k.accent" :label="k.name" :size="18" />
          <span class="nt-agent-body">
            <span class="nt-agent-name">{{ newAgentName(k.name) }}</span>
            <span class="nt-agent-sub">{{ t('tasks.new.startsForTask', 'Starts for this task') }}</span>
          </span>
        </label>
        <label
          v-for="a in openAgents"
          :key="'pane:' + a.id"
          class="nt-agent"
          :class="{ on: who === 'pane:' + a.id, off: taken(a) }"
        >
          <input
            v-model="who"
            type="radio"
            name="nt-who"
            :value="'pane:' + a.id"
            :disabled="taken(a)"
          />
          <BrandIcon :kind="a.agentId" :accent="a.accent" :label="a.title" :size="18" />
          <span class="nt-agent-body">
            <span class="nt-agent-name">#{{ a.num }} {{ a.title }}</span>
            <span class="nt-agent-sub">{{ alreadyOpen(a) }}</span>
          </span>
        </label>
      </div>

      <span class="nt-label">{{ t('tasks.new.where', 'Where it works') }}</span>
      <label class="nt-where" :class="{ on: canIsolate && isolated, off: !canIsolate }">
        <input v-model="isolated" type="radio" name="nt-where" :value="true" :disabled="!canIsolate" />
        <span class="nt-where-body">
          <span class="nt-where-name">{{ t('tasks.new.ownCopy', 'In its own copy') }} <em v-if="canIsolate">{{ t('tasks.new.recommended', 'recommended') }}</em></span>
          <span class="nt-where-sub">
            <template v-if="canIsolate">
              {{
                t(
                  'tasks.new.ownCopyHint',
                  "A new git branch in a separate folder. It cannot break the running app or another agent's work; you review and merge when it is done."
                )
              }}
            </template>
            <template v-else-if="!isNew">{{ t('tasks.new.openWorksWhereItIs', 'An agent that is already open works where it is.') }}</template>
            <template v-else>{{ isolation.reason || t('tasks.new.notAvailable', 'Not available for this project') }}</template>
          </span>
        </span>
      </label>
      <div v-if="canIsolate && isolated" class="nt-copy-opts" data-test="copy-options">
        <label class="nt-copy-opt">
          <span>{{ t('tasks.new.baseBranch', 'Start from branch') }}</span>
          <input v-model="baseBranch" class="nt-select nt-branch" :placeholder="t('tasks.new.currentBranch', 'the current branch')" spellcheck="false" />
        </label>
        <label class="nt-copy-opt"><input v-model="copyEnv" type="checkbox" /> {{ t('tasks.new.copyEnv', "Copy the project's .env files into it") }}</label>
        <label class="nt-copy-opt"><input v-model="runSetup" type="checkbox" /> {{ t('tasks.new.runSetup', 'Run .tessel/setup.ps1 in it first (if the project has one)') }}</label>
      </div>
      <label class="nt-where" :class="{ on: !(canIsolate && isolated) }">
        <input
          v-model="isolated"
          type="radio"
          name="nt-where"
          :value="false"
          :checked="!canIsolate || !isolated"
        />
        <span class="nt-where-body">
          <span class="nt-where-name">{{ t('tasks.new.direct', 'Directly in the project folder') }}</span>
          <span class="nt-where-sub">{{ t('tasks.new.directHint', 'For a small change. Its edits land in the project right away.') }}</span>
        </span>
      </label>

      <label v-if="reviewers.length" class="nt-review">
        <span>{{ t('tasks.new.reviewBy', 'When it is done, ask for a review by') }}</span>
        <select v-model="reviewerId" class="nt-select">
          <option value="">{{ t('tasks.new.nobody', 'nobody') }}</option>
          <option v-for="r in reviewers" :key="r.id" :value="r.id">#{{ r.num }} {{ r.title }}</option>
        </select>
      </label>

      <footer class="nt-actions">
        <button type="button" class="nt-btn" @click="emit('close')">{{ t('tasks.new.cancel', 'Cancel') }}</button>
        <button type="submit" class="nt-btn primary" :disabled="!ready">{{ t('tasks.new.start', 'Start task') }}</button>
      </footer>
    </form>
  </div>
</template>
