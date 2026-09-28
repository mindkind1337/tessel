<script setup>
// Usage details (from the toolbar gauge): for each agent, tokens and the
// estimated cost by day, model, project and conversation, read from its own
// files on this computer. The cost is an estimate at API list prices (Orca's
// table): a subscription is not billed per token.
import { ref, computed, onMounted } from 'vue'
import { t, intlLocale } from '../i18n'

const emit = defineEmits(['close'])
const tab = ref('claude')
const claude = ref(null) // report | { error }
const codex = ref(null)
const hover = ref(null) // { day, cost, turns, x }
const hasCodex = !!window.shellApi.codexUsageReport

async function load() {
  if (window.shellApi.claudeUsageReport)
    claude.value = await window.shellApi.claudeUsageReport().catch((e) => ({ ok: false, error: e.message }))
  if (window.shellApi.codexUsageReport)
    codex.value = await window.shellApi.codexUsageReport({}).catch((e) => ({ ok: false, error: e.message }))
}
onMounted(load)

const r = computed(() => (claude.value && claude.value.ok ? claude.value : null))

const dayLabel = (d) => d.toLocaleDateString(intlLocale(), { month: 'short', day: 'numeric' })

// The last 30 days, one bar a day (a day with nothing is 0).
const days = computed(() => {
  if (!r.value) return []
  const byDay = new Map(r.value.byDay.map((d) => [d.day, d]))
  const out = []
  const now = new Date()
  for (let i = r.value.days - 1; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const got = byDay.get(key)
    out.push({ day: key, label: dayLabel(d), cost: got ? got.cost : 0, turns: got ? got.turns : 0 })
  }
  return out
})
const maxCost = computed(() => Math.max(0.01, ...days.value.map((d) => d.cost)))

// Codex (codexUsageReport.js, Codex's): tokens only, no price table to trust.
// Counters { input, cached, output, reasoning, total, turns } (turns: requests).
const cx = computed(() => (codex.value && codex.value.ok ? codex.value : null))
const cxHover = ref(null)
const cxDays = computed(() => {
  if (!cx.value) return []
  const byDay = new Map((cx.value.byDay || []).map((d) => [d.day, d]))
  const out = []
  const now = new Date()
  for (let i = 29; i >= 0; i--) {
    const d = new Date(now.getFullYear(), now.getMonth(), now.getDate() - i)
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    const got = byDay.get(key)
    out.push({ day: key, label: dayLabel(d), total: got ? got.total || 0 : 0, turns: got ? got.turns || 0 : 0 })
  }
  return out
})
const cxMax = computed(() => Math.max(1, ...cxDays.value.map((d) => d.total)))
const ms = (v) => (typeof v === 'number' ? v : Date.parse(v) || 0)

const money = (v) =>
  new Intl.NumberFormat(intlLocale(), {
    style: 'currency',
    currency: 'USD',
    minimumFractionDigits: v >= 100 ? 0 : 2,
    maximumFractionDigits: v >= 100 ? 0 : 2
  }).format(v >= 100 ? Math.round(v) : v)
const decimal = (v) =>
  v.toLocaleString(intlLocale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })
const count = (v) => v.toLocaleString(intlLocale())
function tokens(v) {
  if (v >= 1e9) return t('usage.units.billions', '{{n}}B', { n: decimal(v / 1e9) })
  if (v >= 1e6) return t('usage.units.millions', '{{n}}M', { n: decimal(v / 1e6) })
  if (v >= 1e3) return t('usage.units.thousands', '{{n}}k', { n: decimal(v / 1e3) })
  return String(v)
}
const when = (ms) =>
  ms
    ? new Date(ms).toLocaleString(intlLocale(), { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })
    : ''
const claudeNote = () =>
  t('usage.dialog.claudeNote', "Estimated at API list prices per million tokens (the price table comes from Orca, open source). With a Claude subscription you are not billed per token: it shows what the same use would cost on the API. Read from Claude Code's own files on this computer ({{files}} conversations); nothing is sent anywhere.", { files: r.value.files })
const folder = (p) => (p ? p.replace(/[\\/]+$/, '').split(/[\\/]/).pop() : '')
</script>

<template>
  <div class="help-backdrop" @pointerdown.self="emit('close')" @keydown.escape.prevent="emit('close')">
    <div class="help-card usage-card" role="dialog" :aria-label="t('usage.dialog.label', 'Usage details')" tabindex="-1">
      <div class="help-head">
        <span>{{ t('usage.dialog.title', 'Usage') }}</span>
        <button
          class="tb-icon"
          :title="t('usage.dialog.closeEsc', 'Close (Esc)')"
          :aria-label="t('usage.dialog.close', 'Close')"
          @click="emit('close')"
        >
          <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
          </svg>
        </button>
      </div>
      <div class="launch-seg">
        <button class="launch-seg-btn" :class="{ on: tab === 'claude' }" @click="tab = 'claude'">{{ 'Claude Code' }}</button>
        <button class="launch-seg-btn" :class="{ on: tab === 'codex' }" @click="tab = 'codex'">Codex</button>
      </div>

      <template v-if="tab === 'claude'">
        <p v-if="!claude" class="usage-note">{{ t('usage.dialog.readingClaude', 'Reading Claude Code\'s conversations…') }}</p>
        <p
          v-else-if="!r"
          class="mcp-error"
          v-text="t('usage.dialog.readError', 'Could not read them: {{error}}', { error: claude.error })"
        ></p>
        <template v-else>
          <div class="usage-tiles" data-test="usage-tiles">
            <div class="usage-tile">
              <span class="usage-tile-value">{{ money(r.lastDays.cost) }}</span>
              <span
                class="usage-tile-label"
                v-text="t('usage.dialog.costLastDays', 'Estimated cost, last {{days}} days', { days: r.days })"
              ></span>
            </div>
            <div class="usage-tile">
              <span class="usage-tile-value">{{ count(r.lastDays.turns) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.replies', 'Replies') }}</span>
            </div>
            <div class="usage-tile">
              <span class="usage-tile-value">{{ tokens(r.lastDays.output) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.tokensWritten', 'Tokens written') }}</span>
            </div>
            <div class="usage-tile">
              <span class="usage-tile-value">{{ tokens(r.lastDays.cacheRead) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.tokensFromCache', 'Tokens read from cache') }}</span>
            </div>
          </div>

          <div class="usage-chart-head">{{ t('usage.dialog.costPerDay', 'Estimated cost per day') }}</div>
          <div
            class="usage-chart"
            role="img"
            :aria-label="
              t('usage.dialog.costPerDayLabel', 'Estimated cost per day over the last {{days}} days', { days: r.days })
            "
            @mouseleave="hover = null"
          >
            <div
              v-for="d in days"
              :key="d.day"
              class="usage-col"
              @mouseenter="hover = d"
            >
              <div class="usage-colbar" :style="{ height: d.cost > 0 ? Math.max(2, (d.cost / maxCost) * 100) + '%' : '0' }"></div>
            </div>
            <div
              v-if="hover"
              class="usage-tip"
              v-text="
                t('usage.dialog.costTip', '{{day}} · {{cost}} · {{count}} replies', {
                  day: hover.label,
                  cost: money(hover.cost),
                  count: hover.turns
                })
              "
            ></div>
          </div>
          <div class="usage-axis"><span>{{ days[0] && days[0].label }}</span><span>{{ t('usage.dialog.today', 'today') }}</span></div>

          <div class="usage-cols2">
            <table class="usage-table">
              <thead>
                <tr>
                  <th>{{ t('usage.dialog.model', 'Model') }}</th>
                  <th>{{ t('usage.dialog.replies', 'Replies') }}</th>
                  <th>{{ t('usage.dialog.estCost', 'Est. cost') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in r.byModel" :key="m.model"><td>{{ m.model }}</td><td>{{ m.turns }}</td><td>{{ money(m.cost) }}</td></tr>
              </tbody>
            </table>
            <table class="usage-table">
              <thead>
                <tr>
                  <th>{{ t('usage.dialog.project', 'Project') }}</th>
                  <th>{{ t('usage.dialog.replies', 'Replies') }}</th>
                  <th>{{ t('usage.dialog.estCost', 'Est. cost') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in r.byProject.slice(0, 10)" :key="p.cwd"><td :title="p.cwd">{{ p.label }}</td><td>{{ p.turns }}</td><td>{{ money(p.cost) }}</td></tr>
              </tbody>
            </table>
          </div>

          <div class="usage-chart-head">{{ t('usage.dialog.conversations', 'Conversations (the costliest first)') }}</div>
          <table class="usage-table usage-sessions">
            <thead>
              <tr>
                <th>{{ t('usage.dialog.project', 'Project') }}</th>
                <th>{{ t('usage.dialog.branch', 'Branch') }}</th>
                <th>{{ t('usage.dialog.lastReply', 'Last reply') }}</th>
                <th>{{ t('usage.dialog.model', 'Model') }}</th>
                <th>{{ t('usage.dialog.replies', 'Replies') }}</th>
                <th>{{ t('usage.dialog.estCost', 'Est. cost') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in r.sessions.slice(0, 20)" :key="s.id" :title="s.id">
                <td>{{ folder(s.cwd) }}</td><td>{{ s.branch || '' }}</td><td>{{ when(s.last) }}</td><td>{{ s.model }}</td><td>{{ s.turns }}</td><td>{{ money(s.cost) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="usage-note" v-text="claudeNote()"></p>
        </template>
      </template>

      <template v-else>
        <p v-if="!codex" class="usage-note">
          {{
            hasCodex
              ? t('usage.dialog.readingCodex', 'Reading Codex’s sessions…')
              : t('usage.dialog.codexSoon', 'Coming soon: Codex’s report is being added.')
          }}
        </p>
        <p
          v-else-if="!cx"
          class="mcp-error"
          v-text="t('usage.dialog.readError', 'Could not read them: {{error}}', { error: codex.error })"
        ></p>
        <template v-else>
          <div class="usage-tiles" data-test="codex-tiles">
            <div class="usage-tile">
              <span class="usage-tile-value">{{ tokens(cx.totals.total || 0) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.tokensLast30', 'Tokens, last 30 days') }}</span>
            </div>
            <div class="usage-tile">
              <span class="usage-tile-value">{{ count(cx.totals.turns || 0) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.requests', 'Requests') }}</span>
            </div>
            <div class="usage-tile">
              <span class="usage-tile-value">{{ tokens(cx.totals.cached || 0) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.inputFromCache', 'Input read from cache') }}</span>
            </div>
            <div class="usage-tile">
              <span class="usage-tile-value">{{ tokens(cx.totals.reasoning || 0) }}</span>
              <span class="usage-tile-label">{{ t('usage.dialog.reasoningTokens', 'Reasoning tokens') }}</span>
            </div>
          </div>

          <div class="usage-chart-head">{{ t('usage.dialog.tokensPerDay', 'Tokens per day') }}</div>
          <div
            class="usage-chart"
            role="img"
            :aria-label="t('usage.dialog.tokensPerDayLabel', 'Codex tokens per day over the last 30 days')"
            @mouseleave="cxHover = null"
          >
            <div v-for="d in cxDays" :key="d.day" class="usage-col" @mouseenter="cxHover = d">
              <div class="usage-colbar" :style="{ height: d.total > 0 ? Math.max(2, (d.total / cxMax) * 100) + '%' : '0' }"></div>
            </div>
            <div
              v-if="cxHover"
              class="usage-tip"
              v-text="
                t('usage.dialog.tokensTip', '{{day}} · {{tokens}} tokens · {{count}} requests', {
                  day: cxHover.label,
                  tokens: tokens(cxHover.total),
                  count: cxHover.turns
                })
              "
            ></div>
          </div>
          <div class="usage-axis"><span>{{ cxDays[0] && cxDays[0].label }}</span><span>{{ t('usage.dialog.today', 'today') }}</span></div>

          <div class="usage-cols2">
            <table class="usage-table">
              <thead>
                <tr>
                  <th>{{ t('usage.dialog.model', 'Model') }}</th>
                  <th>{{ t('usage.dialog.requests', 'Requests') }}</th>
                  <th>{{ t('usage.dialog.tokens', 'Tokens') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="m in cx.byModel || []" :key="m.model"><td>{{ m.model }}</td><td>{{ m.turns }}</td><td>{{ tokens(m.total || 0) }}</td></tr>
              </tbody>
            </table>
            <table class="usage-table">
              <thead>
                <tr>
                  <th>{{ t('usage.dialog.project', 'Project') }}</th>
                  <th>{{ t('usage.dialog.requests', 'Requests') }}</th>
                  <th>{{ t('usage.dialog.tokens', 'Tokens') }}</th>
                </tr>
              </thead>
              <tbody>
                <tr v-for="p in (cx.byProject || []).slice(0, 10)" :key="p.cwd"><td :title="p.cwd">{{ p.label || folder(p.cwd) }}</td><td>{{ p.turns }}</td><td>{{ tokens(p.total || 0) }}</td></tr>
              </tbody>
            </table>
          </div>

          <div class="usage-chart-head">{{ t('usage.dialog.sessions', 'Sessions') }}</div>
          <table class="usage-table usage-sessions">
            <thead>
              <tr>
                <th>{{ t('usage.dialog.titleColumn', 'Title') }}</th>
                <th>{{ t('usage.dialog.project', 'Project') }}</th>
                <th>{{ t('usage.dialog.last', 'Last') }}</th>
                <th>{{ t('usage.dialog.model', 'Model') }}</th>
                <th>{{ t('usage.dialog.requests', 'Requests') }}</th>
                <th>{{ t('usage.dialog.tokens', 'Tokens') }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in (cx.sessions || []).slice(0, 20)" :key="s.id" :title="s.id">
                <td>{{ s.title || '' }}</td><td>{{ folder(s.cwd) }}</td><td>{{ when(ms(s.last)) }}</td><td>{{ s.model }}</td><td>{{ (s.tokens && s.tokens.turns) || 0 }}</td><td>{{ tokens((s.tokens && s.tokens.total) || 0) }}</td>
              </tr>
            </tbody>
          </table>
          <p class="usage-note">
            {{
              t('usage.dialog.codexNote', 'Read from Codex\'s own session files on this computer; nothing is sent anywhere. No cost in $: Codex has no price table Tessel can check.'
              )
            }}
          </p>
        </template>
      </template>
    </div>
  </div>
</template>
