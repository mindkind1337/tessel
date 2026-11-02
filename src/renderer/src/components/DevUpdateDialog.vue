<script setup>
// A development Tessel (npm run dev) follows the repository: this says there are
// new builds on GitHub, lists them, and brings them in (a fast-forward, only for
// a copy with no change of its own; src/main/devUpdate.js). It never installs
// packages and never restarts by itself: it says what the user does next.
import { ref, computed, onMounted } from 'vue'
import { X, Copy } from 'lucide-vue-next'
import { t } from '../i18n'

const props = defineProps({
  status: { type: Object, required: true },
  // The build running (b<commits>), to compare with the new one.
  build: { type: Object, default: null },
  // 'restart': the background code changed since Tessel started (status is { count, files }).
  mode: { type: String, default: 'update' }
})
const emit = defineEmits(['apply', 'close', 'copy', 'restart'])

const busy = ref(false)
const failed = ref('')
const done = ref(null)

const s = computed(() => props.status || {})
const isRestart = computed(() => props.mode === 'restart')
const head = computed(() =>
  isRestart.value
    ? t('app.devUpdate.restartTitle', 'Restart to apply the changes')
    : done.value || s.value.state === 'updated'
    ? t('app.devUpdate.updatedTitle', 'Tessel is up to date')
    : t('app.devUpdate.title', 'New builds on GitHub: {{count}}', { count: s.value.behind || 0 })
)
const line = computed(() => {
  const now = props.build && props.build.count ? `b${props.build.count}` : ''
  const next = s.value.newBuild ? `b${s.value.newBuild}` : ''
  return now && next
    ? t('app.devUpdate.from', 'You have {{now}}. GitHub has {{next}}.', { now, next })
    : t('app.devUpdate.fromShort', 'GitHub has builds this copy does not have.')
})
const restartLine = computed(() => t('app.devUpdate.restartLine', 'The code of the background part changed since Tessel started ({{count}} file): what runs is the old one.', { count: s.value.count || 0 }))
const moreText = computed(() => t('app.devUpdate.more', '… and {{count}} more', { count: (s.value.behind || 0) - (s.value.commits || []).length }))
const blockedText = computed(() =>
  s.value.blocked === 'dirty'
    ? t('app.devUpdate.dirty', 'This copy has changes that are not committed: Tessel does not touch it. Commit or put them aside, then run git pull.')
    : s.value.blocked === 'ahead'
      ? t('app.devUpdate.ahead', 'This copy has commits that GitHub does not have: Tessel does not merge them for you. Run git pull yourself.')
      : ''
)
const reasonText = computed(() => {
  const r = failed.value
  if (!r) return ''
  if (r === 'dirty' || r === 'ahead') return blockedText.value || t('app.devUpdate.failed', 'The update could not be done: run git pull in the repository.')
  if (r === 'current') return t('app.devUpdate.current', 'This copy is already up to date.')
  return t('app.devUpdate.failed', 'The update could not be done: run git pull in the repository.')
})
const result = computed(() => done.value || (s.value.state === 'updated' ? s.value : null))
const afterText = computed(() => {
  const r = result.value
  if (!r) return ''
  const parts = []
  if (r.depsChanged) parts.push(t('app.devUpdate.deps', 'The packages changed: they install by themselves when you restart.'))
  else if (r.mainChanged) parts.push(t('app.devUpdate.restart', 'Restart npm run dev to load the changes of the main process.'))
  else parts.push(t('app.devUpdate.reload', 'The window reloads by itself; nothing to restart.'))
  return parts.join(' ')
})

const restarting = ref(false)
// The new Tessel starts in the background and this window closes; if it does
// not, the reason is said here.
async function restart() {
  if (restarting.value) return
  restarting.value = true
  failed.value = ''
  const r = await new Promise((resolve) => emit('restart', resolve))
  if (!r || !r.ok) {
    restarting.value = false
    failed.value = (r && r.reason) || 'spawn'
  }
}
// After an update, restarting is offered when it is needed (the packages install as it starts: launch.mjs).
const canRestartAfter = computed(() => !!result.value && (result.value.depsChanged || result.value.mainChanged !== false))
const restartFailed = computed(() =>
  failed.value === 'cancelled' ? '' : failed.value ? t('app.devUpdate.restartFailed', 'Tessel could not start the new one: close it and run npm run dev yourself.') : ''
)

async function apply() {
  if (busy.value) return
  busy.value = true
  failed.value = ''
  try {
    const r = await new Promise((resolve) => emit('apply', resolve))
    if (r && r.ok) done.value = r
    else failed.value = (r && r.reason) || 'merge'
  } finally {
    busy.value = false
  }
}

const cardEl = ref(null)
onMounted(() => cardEl.value && cardEl.value.focus())
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')">
    <div
      ref="cardEl"
      class="help-card update-card"
      role="dialog"
      :aria-label="t('app.devUpdate.label', 'Update this development copy')"
      tabindex="-1"
      data-test="dev-update"
      @keydown.escape.prevent.stop="emit('close')"
    >
      <div class="help-head">
        <span>{{ head }}</span>
        <button class="tb-icon" :title="t('app.update.close', 'Close (Esc)')" :aria-label="t('app.update.close', 'Close (Esc)')" @click="emit('close')">
          <X :size="14" aria-hidden="true" />
        </button>
      </div>

      <template v-if="isRestart">
        <p class="update-line">{{ restartLine }}</p>
        <ul v-if="s.files && s.files.length" class="dev-update-list" data-test="dev-restart-list">
          <li v-for="f in s.files" :key="f">
            <code>{{ f }}</code>
          </li>
          <li v-if="s.count > s.files.length" class="dim">{{ t('app.devUpdate.moreFiles', '… and more') }}</li>
        </ul>
        <p class="update-line dim">{{ t('app.devUpdate.restartHow', 'Restart now starts the new Tessel in the background (its messages go to the dev-server log) and closes this one. Your terminals and agents keep running: the window reattaches to them. Or close Tessel and run npm run dev yourself, when it suits you.') }}</p>
        <p v-if="restartFailed" class="update-line dim" data-test="dev-restart-error">{{ restartFailed }}</p>
      </template>
      <template v-else-if="!result">
        <p class="update-line">{{ line }}</p>
        <ul v-if="s.commits && s.commits.length" class="dev-update-list" data-test="dev-update-list">
          <li v-for="c in s.commits" :key="c.hash">
            <code>{{ c.hash }}</code> {{ c.subject }}
          </li>
          <li v-if="s.behind > s.commits.length" class="dim">{{ moreText }}</li>
        </ul>
        <p v-if="blockedText" class="update-line dim" data-test="dev-update-blocked">{{ blockedText }}</p>
        <p v-if="reasonText && !blockedText" class="update-line dim" data-test="dev-update-error">{{ reasonText }}</p>
        <p v-if="s.depsChanged" class="update-line dim">{{ t('app.devUpdate.depsWarn', 'These builds change the packages (package.json): they install by themselves at the next restart.') }}</p>
      </template>
      <template v-else>
        <p class="update-line" data-test="dev-update-after">{{ afterText }}</p>
        <p v-if="restartFailed" class="update-line dim" data-test="dev-restart-error">{{ restartFailed }}</p>
      </template>

      <div class="update-actions">
        <button class="exit-btn" @click="emit('close')">{{ result || isRestart ? t('app.devUpdate.close', 'Close') : t('app.update.later', 'Later') }}</button>
        <button v-if="isRestart || canRestartAfter" class="exit-btn primary" :disabled="restarting" data-test="dev-restart-now" @click="restart">
          {{ restarting ? t('app.devUpdate.restarting', 'Restarting…') : t('app.devUpdate.restartNow', 'Restart now') }}
        </button>
        <button v-if="!isRestart && !result && blockedText" class="exit-btn" data-test="dev-update-copy" @click="emit('copy', 'git pull --ff-only')">
          <Copy :size="12" aria-hidden="true" /> {{ t('app.devUpdate.copy', 'Copy git pull') }}
        </button>
        <button v-if="!isRestart && !result && !blockedText" class="exit-btn primary" :disabled="busy" data-test="dev-update-apply" @click="apply">
          {{ busy ? t('app.devUpdate.updating', 'Updating…') : t('app.devUpdate.apply', 'Update') }}
        </button>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dev-update-list {
  margin: 8px 0;
  padding-left: 18px;
  max-height: 220px;
  overflow: auto;
  color: var(--text);
  font-size: 12px;
  line-height: 1.6;
}
.dev-update-list code {
  color: var(--text-dim, var(--text));
  font-size: 11px;
}
.dev-update-list .dim {
  color: var(--text-dim, var(--text));
  list-style: none;
  margin-left: -18px;
}
</style>
