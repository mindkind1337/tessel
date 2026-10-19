<script setup>
// What waits for your answer in your Live Share (liveShareWindow.js asks):
// - someone asks to join: the invitation they used, the verification code
//   their Tessel shows (a callout, with "I checked it with them"), the
//   projects they will see as chips (the invitation's ticked; at least one),
//   and what they can do: the presets and the rights grid (RightsGrid: Type
//   in red, it runs commands as you), with the agents they may use under it
//   (LsAgents). So letting them in is one click; you can change it first.
//   Once the code was checked, you can trust them next time (their Tessel has
//   an identity key: trustable); before that the box waits, and says why;
// - a guest without the right to open asks to open a terminal or one of your
//   agents in a shared project (Open it, Don't open, or Always let them open:
//   it opens and they get the right to open, which your Tessel still checks
//   on every request);
// - a guest asks to close an agent or a running terminal (Close it or Keep
//   it).
// Over every dialog, Live Share's included. The keyboard goes to the card,
// not to a button: keys typed for something else (Enter, Space, Escape)
// answer nothing, and the yes only answers after a moment (again each time
// the projects listed change), so a click meant for something else never
// says yes. A click beside it does not answer: it keeps waiting. Each answer
// goes to the one ask it was shown for (its key). Asks come one at a time;
// how many more wait is said.
import { ref, computed, watch, nextTick, onMounted, onUnmounted } from 'vue'
import { UserPlus, XCircle, SquareTerminal, ShieldCheck, AlertTriangle, Check } from 'lucide-vue-next'
import RightsGrid from './liveshare/RightsGrid.vue'
import LsAgents from './liveshare/LsAgents.vue'
import { cleanRights, setRight, withAgents } from '../../../shared/liveShareRights'
import { presetRights, rightsPreset } from '../liveShareRights'
import { viaName } from '../liveShareAccess'
import { t } from '../i18n'

const ARM_MS = 900

const props = defineProps({
  // { kind: 'join', key, name, code, invite, offer, trustable }, { kind:
  // 'open', key, name, spec, projectName, agentName } or { kind: 'close',
  // key, name, paneName, detail }; null when nothing waits.
  ask: { type: Object, default: null },
  // The projects you share ({ id, name }): a guest let in sees the ones
  // ticked.
  projects: { type: Array, default: () => [] },
  // How many more asks wait after this one (shown in turn).
  more: { type: Number, default: 0 },
  // Your agents ([{ id, name, models }]) and the share's agents setting
  // (followed while the guest has no rule of its own), for LsAgents.
  agents: { type: Array, default: () => [] },
  shareRule: { type: Object, default: null }
})
// answer({ key, yes, projects, rights, trust }): for a join, the projects
// ticked, the rights ticked (with their agents rule), and whether they are
// trusted from now on. For an open: { key, yes, always }.
const emit = defineEmits(['answer'])

const kind = computed(() => (props.ask ? props.ask.kind : null))
const isJoin = computed(() => kind.value === 'join')
const who = computed(() => (props.ask && props.ask.name) || t('liveShare.guest', 'A guest'))
// Its {{name}} would end a template interpolation: built here.
const title = computed(() => {
  const a = props.ask
  if (!a) return ''
  const name = who.value
  if (a.kind === 'close') return t('liveShare.closeAsk.title', '{{name}} wants to close {{pane}}', { name, pane: a.paneName || '?' })
  if (a.kind === 'open')
    return a.agentName ? t('liveShare.openAsk.titleAgent', '{{name}} asks to open {{agent}}', { name, agent: a.agentName }) : t('liveShare.openAsk.titleTerminal', '{{name}} asks to open a terminal', { name })
  return t('liveShare.ask.title', '{{name}} wants to join your Live Share', { name })
})

// The projects this guest will see: the ones ticked. Those its invitation
// offers are ticked (without an invitation's offer: every one listed first);
// one shared while it waits is not, and your own ticks stay.
let listed = new Set()
const ticked = ref(new Set())
const rights = ref(cleanRights(null))
const codeChecked = ref(false)
const trust = ref(false)
const offered = () => {
  const offer = props.ask && props.ask.offer
  return offer ? new Set((offer.projects || []).filter((id) => props.projects.some((p) => p.id === id))) : new Set(props.projects.map((p) => p.id))
}
const chosen = computed(() => props.projects.filter((p) => ticked.value.has(p.id)).map((p) => p.id))
function toggle(p) {
  const next = new Set(ticked.value)
  if (next.has(p.id)) next.delete(p.id)
  else next.add(p.id)
  ticked.value = next
}
function toggleRight(id, on) {
  rights.value = setRight(rights.value, id, on)
}
// A preset sets every right; the agents rule stays as it was.
function pickPreset(id) {
  rights.value = withAgents(presetRights(id), rights.value.agents || null)
}
function setAgents(rule) {
  rights.value = withAgents(rights.value, rule)
}
const canType = computed(() => rights.value.type === true)
// Type on: said in red (Full control's own line already says it).
const typeWarn = computed(() => canType.value && rightsPreset(rights.value) !== 'full')
const viaText = computed(() => {
  const a = props.ask
  if (!a || !a.invite) return ''
  return t('liveShare.ask.via', 'With the invitation “{{invite}}”', { invite: viaName(a.invite) })
})
// Trust is offered for a Tessel that can be trusted, once the code was
// checked (the person is who they say).
const canTrust = computed(() => isJoin.value && !!props.ask.trustable && !!props.ask.code)

const openText = computed(() => {
  const a = props.ask
  if (!a || a.kind !== 'open') return ''
  return t('liveShare.openAsk.text', 'It runs on your computer, in {{project}}, with your settings. Everyone in the session sees it, and those you let type can type in it.', { project: a.projectName || '?' })
})
const alwaysText = computed(() => t('liveShare.openAsk.always', 'Always let {{name}} open', { name: who.value }))
const alwaysHint = computed(() => t('liveShare.openAsk.alwaysHint', 'Opens it, and gives {{name}} “Open terminals and agents” from now on (you can take it back in People).', { name: who.value }))

const moreText = computed(() =>
  props.more === 1 ? t('liveShare.ask.more', '{{count}} more waiting after this one', { count: 1 }) : t('liveShare.ask.more', '{{count}} more waiting after this one', { count: props.more })
)

const dialog = ref(null)
const armed = ref(false)
let armTimer = 0
let previousFocus = null
// Allowing someone in needs one project ticked at least (none listed yet: a
// share taken back after a restart, before the window found its projects).
const canAllow = computed(() => armed.value && (!isJoin.value || chosen.value.length > 0))
const waitingForProjects = computed(() => isJoin.value && !props.projects.length)

function arm() {
  armed.value = false
  clearTimeout(armTimer)
  armTimer = setTimeout(() => (armed.value = true), ARM_MS)
}
function shown() {
  if (!previousFocus) previousFocus = document.activeElement
  listed = new Set(props.projects.map((p) => p.id))
  ticked.value = offered()
  rights.value = cleanRights(props.ask && props.ask.offer ? props.ask.offer.rights : null)
  codeChecked.value = false
  trust.value = false
  arm()
  nextTick(() => dialog.value?.focus())
}
// The projects listed changed while it waits: new ones come unticked (the
// first ones, when there were none, as offered), and the yes waits a moment
// again.
function listChanged() {
  if (!isJoin.value) return
  const first = !listed.size
  const offer = offered()
  const next = new Set(ticked.value)
  for (const p of props.projects) {
    if (listed.has(p.id)) continue
    listed.add(p.id)
    if (first && offer.has(p.id)) next.add(p.id)
  }
  ticked.value = next
  arm()
}
function restoreFocus() {
  clearTimeout(armTimer)
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  previousFocus = null
}
watch(
  () => props.ask && props.ask.key,
  (key) => (key ? shown() : restoreFocus())
)
watch(() => props.projects.map((p) => p.id).join('\n'), listChanged)
watch(codeChecked, (on) => !on && (trust.value = false))
onMounted(() => {
  if (props.ask) shown()
})
onUnmounted(restoreFocus)

function answer(yes, always = false) {
  if (!props.ask || (yes && !canAllow.value)) return
  if (kind.value === 'open') emit('answer', { key: props.ask.key, yes: !!yes, ...(yes && always ? { always: true } : {}) })
  else if (!isJoin.value) emit('answer', { key: props.ask.key, yes: !!yes })
  else emit('answer', { key: props.ask.key, yes: !!yes, projects: [...chosen.value], rights: cleanRights(rights.value), trust: !!(yes && canTrust.value && codeChecked.value && trust.value) })
}

function trapTab(event) {
  const buttons = [...(dialog.value?.querySelectorAll('button:not(:disabled), input:not(:disabled)') || [])].filter((el) => !el.closest('[style*="display: none"]'))
  if (!buttons.length) return
  const i = buttons.indexOf(document.activeElement)
  if (event.shiftKey && i <= 0) {
    event.preventDefault()
    buttons.at(-1).focus()
  } else if (!event.shiftKey && i === buttons.length - 1) {
    event.preventDefault()
    buttons[0].focus()
  }
}
</script>

<template>
  <div v-if="ask" class="help-backdrop confirm-backdrop ls-ask-backdrop">
    <div
      ref="dialog"
      class="help-card confirm-card ls-ask-card"
      :class="{ join: isJoin }"
      role="alertdialog"
      aria-modal="true"
      aria-labelledby="ls-ask-title"
      aria-describedby="ls-ask-text"
      tabindex="-1"
      data-test="live-share-ask"
      @focusin.stop
      @keydown.escape.prevent.stop
      @keydown.tab.stop="trapTab"
    >
      <h2 id="ls-ask-title" class="confirm-title ls-ask-title">
        <XCircle v-if="kind === 'close'" :size="16" aria-hidden="true" />
        <SquareTerminal v-else-if="kind === 'open'" :size="16" aria-hidden="true" />
        <UserPlus v-else :size="16" aria-hidden="true" />
        <span>{{ title }}</span>
      </h2>
      <div id="ls-ask-text" class="confirm-text ls-ask-body">
        <template v-if="kind === 'close'">
          <p class="ls-ask-p">{{ ask.detail }}</p>
          <p class="ls-ask-p ls-ask-dim">{{ t('liveShare.closeAsk.text', 'It closes on your computer, for everyone in the session.') }}</p>
        </template>
        <template v-else-if="kind === 'open'">
          <p class="ls-ask-p" data-test="ls-ask-open-text">{{ openText }}</p>
        </template>
        <template v-else>
          <p v-if="viaText" class="ls-ask-p ls-ask-via" data-test="ls-ask-invite">{{ viaText }}</p>

          <!-- The verification code: checked with them before anything else. -->
          <div v-if="ask.code" class="set-callout info ls-ask-code-box" data-test="ls-ask-code">
            <ShieldCheck :size="16" aria-hidden="true" />
            <div class="set-callout-text">
              <div class="ls-ask-code-line">
                <span>{{ t('liveShare.ask.codeLabel', 'Verification code') }}</span>
                <strong class="ls-ask-code-value">{{ ask.code }}</strong>
              </div>
              <div class="ls-ask-dim">{{ t('liveShare.ask.codeHint', 'Their Tessel shows it too. Check with them that it is the same before you allow.') }}</div>
              <label class="ls-ask-check" data-test="ls-ask-code-checked">
                <input v-model="codeChecked" type="checkbox" />
                <span>{{ t('liveShare.ask.codeChecked2', 'I checked it with them: it is the same') }}</span>
              </label>
            </div>
          </div>

          <div class="ls-ask-section">
            <div class="ls-ask-label">{{ t('liveShare.ask.projectsLabel', 'Projects they will see') }}</div>
            <div v-if="projects.length" class="ls-ask-projects" role="group" :aria-label="t('liveShare.ask.projectsLabel', 'Projects they will see')" data-test="ls-ask-projects">
              <label v-for="p in projects" :key="p.id" class="chip ls-ask-chip" :class="{ on: ticked.has(p.id) }" :title="p.name" :data-test="'ls-ask-project-' + p.id">
                <input type="checkbox" :checked="ticked.has(p.id)" @change="toggle(p)" />
                <Check v-if="ticked.has(p.id)" :size="11" aria-hidden="true" />
                <span class="ls-ask-chip-name">{{ p.name }}</span>
              </label>
            </div>
            <p v-if="projects.length && !chosen.length" class="ls-ask-p ls-ask-warn" data-test="ls-ask-need-project">{{ t('liveShare.ask.needProject', 'Tick at least one project to allow them in.') }}</p>
            <p v-if="waitingForProjects" class="ls-ask-p ls-ask-dim" data-test="ls-ask-no-projects">
              {{ t('liveShare.ask.noProjects', 'Tessel is still finding the projects you share: wait a moment to allow them in.') }}
            </p>
          </div>

          <div class="ls-ask-section" data-test="ls-ask-rights">
            <div class="ls-ask-label">{{ t('liveShare.ask.rightsLabel', 'What they can do (they can always watch)') }}</div>
            <RightsGrid :rights="rights" presets test-key="ask" :label="t('liveShare.ask.rightsLabel', 'What they can do (they can always watch)')" @toggle="toggleRight" @preset="pickPreset" />
            <LsAgents class="ls-ask-agents" :rule="rights.agents || null" :agents="agents" :share-rule="shareRule" :can-type="canType" test-key="ask" @change="setAgents" />
            <div v-if="typeWarn" class="set-callout danger ls-ask-type" role="note" data-test="ls-ask-type-warning">
              <AlertTriangle :size="14" aria-hidden="true" />
              <span class="set-callout-text">{{ t('liveShare.ask.typeWarning', 'They can type: they can run any command on this PC as you. Only for someone you trust.') }}</span>
            </div>
          </div>

          <div v-if="canTrust" class="ls-ask-section ls-ask-trust" data-test="ls-ask-trust">
            <label class="ls-ask-check" :class="{ disabled: !codeChecked }" data-test="ls-ask-trust-box">
              <input v-model="trust" type="checkbox" :disabled="!codeChecked" />
              <span class="ls-ask-check-text">
                <span>{{ t('liveShare.ask.trust2', 'Trust next time: they get in without asking, with these projects and rights') }}</span>
                <span v-if="!codeChecked" class="ls-ask-dim ls-ask-small" data-test="ls-ask-trust-why">{{ t('liveShare.ask.trustNeedsCode', 'Check the verification code first.') }}</span>
              </span>
            </label>
          </div>
        </template>
      </div>
      <p v-if="more > 0" class="ls-ask-more" data-test="ls-ask-more" v-text="moreText"></p>
      <div class="confirm-actions">
        <button class="confirm-btn" data-test="ls-ask-deny" @click="answer(false)">
          {{ kind === 'close' ? t('liveShare.closeAsk.keep', 'Keep it') : kind === 'open' ? t('liveShare.openAsk.no', 'Don’t open') : t('liveShare.ask.deny', 'Deny') }}
        </button>
        <button v-if="kind === 'open'" class="confirm-btn" :disabled="!canAllow" :title="alwaysHint" data-test="ls-ask-always" @click="answer(true, true)">{{ alwaysText }}</button>
        <button class="confirm-btn primary" :class="{ danger: kind === 'close' }" :disabled="!canAllow" data-test="ls-ask-allow" @click="answer(true)">
          {{ kind === 'close' ? t('liveShare.closeAsk.close', 'Close it') : kind === 'open' ? t('liveShare.openAsk.yes', 'Open it') : t('liveShare.ask.allow', 'Allow') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* Above Live Share's own dialog and the confirmations. */
.ls-ask-backdrop {
  z-index: 650;
}
.ls-ask-card {
  width: min(480px, 100%);
}
/* A join: the rights grid needs room (two tiles a row at least). */
.ls-ask-card.join {
  width: min(560px, 100%);
}
.ls-ask-body {
  max-height: min(68vh, 640px);
  overflow-y: auto;
}
.ls-ask-title {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  overflow-wrap: anywhere;
}
.ls-ask-title svg {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--accent);
}
.ls-ask-p {
  margin: 0 0 8px;
  overflow-wrap: anywhere;
}
.ls-ask-dim {
  color: var(--text-dim);
}
.ls-ask-small {
  font-size: 11.5px;
}
.ls-ask-warn {
  color: var(--warn);
  font-size: 12px;
}
.ls-ask-via {
  color: var(--text);
}
.ls-ask-code-box {
  margin: 0 0 12px;
  align-items: flex-start;
}
.ls-ask-code-box > svg {
  margin-top: 2px;
}
.ls-ask-code-line {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 10px;
  color: var(--text);
}
.ls-ask-code-value {
  color: var(--text-strong);
  font-family: var(--mono-font, ui-monospace, monospace);
  font-size: 17px;
  letter-spacing: 0.08em;
}
.ls-ask-section {
  margin: 0 0 12px;
}
.ls-ask-label {
  margin-bottom: 6px;
  color: var(--text-dim);
  font-size: 12px;
}
.ls-ask-projects {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  max-height: 20vh;
  overflow-y: auto;
}
.ls-ask-chip {
  position: relative;
  max-width: 100%;
  font-size: 12px;
}
.ls-ask-chip input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.ls-ask-chip:has(:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 1px;
}
.ls-ask-chip svg {
  color: var(--accent);
}
.ls-ask-chip-name {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}
.ls-ask-agents {
  margin-top: 10px;
  padding-top: 8px;
  border-top: 1px solid var(--border);
}
.ls-ask-type {
  margin: 8px 0 0;
}
.ls-ask-check {
  display: flex;
  align-items: flex-start;
  gap: 8px;
  margin-top: 6px;
  color: var(--text);
  cursor: pointer;
  overflow-wrap: anywhere;
}
.ls-ask-check.disabled {
  cursor: default;
}
.ls-ask-check.disabled > .ls-ask-check-text > span:first-child {
  color: var(--text-dim);
}
.ls-ask-check-text {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.ls-ask-check input {
  flex: none;
  margin: 2px 0 0;
  accent-color: var(--accent);
}
.ls-ask-more {
  margin: 4px 0 0;
  color: var(--warn);
  font-size: 12px;
}
.ls-ask-trust {
  padding: 2px 10px 8px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.help-card:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: 2px;
}
</style>
