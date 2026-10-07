<script setup>
// One task of the Task history tab (TaskHistoryPanel.vue): its line, and
// when open its details (work periods, cost per model). A component of its
// own so opening one row re-renders that row only, not the whole list.
import { ChevronRight, ChevronDown, ExternalLink } from 'lucide-vue-next'
import BrandIcon from './BrandIcon.vue'
import { pricedUsd } from '../taskHistoryView'
import { formatTokens } from '../jobCost'
import { modelLabel } from '../../../shared/modelLabel'
import { when, clock, duration, tokensText, tokensTitle, costCell, estimateHint, usdText, reasonText, subagentsText, agentLabel } from '../taskHistoryText'
import { t } from '../i18n'

defineProps({
  record: { type: Object, required: true },
  open: { type: Boolean, default: false },
  // Its agent pane still exists.
  alive: { type: Boolean, default: false }
})
const emit = defineEmits(['toggle', 'focus-pane'])
</script>

<template>
  <div class="th-item" role="listitem" :data-id="record.id" :data-test="'history-row-' + record.id">
    <button type="button" class="th-row" :class="{ open }" :aria-expanded="open" @click="emit('toggle', record.id)">
      <component :is="open ? ChevronDown : ChevronRight" :size="12" class="th-chevron" aria-hidden="true" />
      <span class="th-main">
        <span class="th-line1">
          <span class="th-task" :title="record.title">{{ record.title }}</span>
          <span class="th-cost" :class="{ dim: pricedUsd(record) === null }" :title="estimateHint()" data-test="row-cost">{{ costCell(record) }}</span>
        </span>
        <span class="th-line2">
          <span class="th-date" data-test="row-date">{{ when(record.doneAt) }}</span>
          <span class="th-agent" data-test="row-agent"><BrandIcon v-if="record.agentKind" :kind="record.agentKind" :size="12" />{{ agentLabel(record) }}</span>
          <span v-if="record.project" class="th-project" data-test="row-project">{{ record.project }}</span>
          <span class="th-time" data-test="row-time">{{ duration(record.durationMs) }}</span>
          <span class="th-tokens" :title="tokensTitle(record.cost)" data-test="row-tokens">{{ tokensText(record) }}</span>
        </span>
      </span>
    </button>
    <div v-if="open" class="th-detail" data-test="history-detail">
      <div class="th-detail-head">
        <span>{{ t('taskHistory.detail.periods', 'Work periods') }}</span>
        <button v-if="alive" type="button" class="th-open-btn" data-test="history-open-pane" @click="emit('focus-pane', record.paneId)">
          <ExternalLink :size="12" aria-hidden="true" />{{ t('taskHistory.detail.openPane', 'Open agent pane') }}
        </button>
      </div>
      <ul v-if="record.workPeriods && record.workPeriods.length" class="th-periods">
        <li v-for="(p, i) in record.workPeriods" :key="i">{{ when(p.start) }} – {{ clock(p.end || p.start) }} · {{ duration((p.end || p.start) - p.start) }}</li>
      </ul>
      <div v-else class="th-dim">{{ t('taskHistory.detail.noPeriods', 'No time in Doing was recorded.') }}</div>
      <template v-if="record.cost && record.cost.status === 'ok'">
        <div class="th-detail-head">{{ t('taskHistory.detail.models', 'Cost by model') }}</div>
        <table class="th-models" data-test="history-models"><tbody>
          <tr v-for="(m, i) in record.cost.models" :key="i">
            <td>{{ modelLabel(m.model) || m.model || t('taskHistory.detail.unknownModel', 'Unknown model') }}</td>
            <td :title="tokensTitle({ status: 'ok', ...m })">{{ formatTokens((m.inputTokens || 0) + (m.outputTokens || 0)) }}</td>
            <td :title="estimateHint()">{{ m.known && typeof m.usd === 'number' ? usdText(m.usd) : t('taskHistory.unknown', 'unknown') }}</td>
          </tr>
        </tbody></table>
        <div v-if="record.cost.subagents" class="th-dim" data-test="history-subagents">
          {{ subagentsText(record.cost.subagents) }}
        </div>
        <div v-if="record.cost.incomplete" class="th-dim">{{ t('taskHistory.detail.incomplete', 'Some of its panes could not be read: the figures may be low.') }}</div>
      </template>
      <div v-else-if="record.cost" class="th-dim" data-test="history-reason">{{ reasonText(record.cost) }}</div>
      <div v-else class="th-dim">{{ t('taskHistory.detail.reading', 'Reading the figures…') }}</div>
    </div>
  </div>
</template>

<style scoped>
.th-item {
  border-bottom: 1px solid var(--border);
}
.th-row {
  display: flex;
  width: 100%;
  align-items: flex-start;
  gap: 4px;
  padding: 6px 10px 6px 6px;
  border: 0;
  background: transparent;
  color: inherit;
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.th-row:hover,
.th-row.open {
  background: var(--surface-2);
}
.th-chevron {
  flex: 0 0 auto;
  margin-top: 2px;
  color: var(--text-dim);
}
.th-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  min-width: 0;
  gap: 2px;
}
.th-line1 {
  display: flex;
  align-items: baseline;
  gap: 8px;
}
.th-task {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--text-strong);
  white-space: nowrap;
  text-overflow: ellipsis;
}
.th-cost {
  flex: 0 0 auto;
  font-variant-numeric: tabular-nums;
}
.th-cost.dim {
  color: var(--text-dim);
}
.th-line2 {
  display: flex;
  flex-wrap: wrap;
  gap: 2px 10px;
  color: var(--text-dim);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.th-agent {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  max-width: 100%;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.th-detail {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 4px 10px 10px 22px;
  background: var(--surface-2);
  font-size: 11.5px;
}
.th-detail-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-top: 4px;
  color: var(--text-strong);
  font-weight: 600;
}
.th-open-btn {
  display: inline-flex;
  align-items: center;
  gap: 4px;
  padding: 2px 8px;
  border: 1px solid var(--border-strong);
  border-radius: var(--radius);
  background: var(--surface-3);
  color: var(--text-strong);
  font: inherit;
  font-weight: 400;
  cursor: pointer;
}
.th-open-btn:hover {
  border-color: var(--accent);
}
.th-periods {
  margin: 0;
  padding-left: 16px;
  color: var(--text);
  font-variant-numeric: tabular-nums;
}
.th-models {
  border-collapse: collapse;
  font-variant-numeric: tabular-nums;
}
.th-models td {
  padding: 1px 12px 1px 0;
}
.th-dim {
  color: var(--text-dim);
}
</style>
