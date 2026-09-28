<script setup>
// One workspace card (the project folder, or a task copy) with its status
// lane, title, branch, live ports and the agents / terminals working in it.
// Ported from Orca's legacy "Detailed" worktree card: worktree-card-surface,
// worktree-card-parent-content, worktree-card-header, worktree-card-meta-row,
// WorktreeCardStatusSlot, WorktreeCardAgents, worktree-card-compact-agents
// and worktree-card-compact-agent-row (MIT, Copyright (c) 2026 Lovecast Inc.).
import { computed } from 'vue'
import { Bell, ChevronDown } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import AgentStateDot from './AgentStateDot.vue'
import CompactAgentRow from './CompactAgentRow.vue'
import WorktreeCardPorts from './WorktreeCardPorts.vue'
import {
  buildSummaryAgentGroups,
  selectSummaryGroupIconAgents,
  summarizeAgents,
  summarizeAgentIdentities,
  getWorktreeStatusLabel
} from '../../sidebarModel'
import { t } from '../../i18n'

const props = defineProps({
  card: { type: Object, required: true },
  grouped: { type: Boolean, default: true },
  compactCards: { type: Boolean, default: false },
  showPorts: { type: Boolean, default: true },
  showAgents: { type: Boolean, default: true },
  agentMode: { type: String, default: 'compact' }, // 'compact' | 'full'
  expanded: { type: Boolean, default: false },
  ports: { type: Array, default: () => [] },
  projectName: { type: String, default: '' },
  showProjectBadge: { type: Boolean, default: false },
  // Ticking agents for a team: { active, picked: [ids], canPick(row), why(row) }
  picking: { type: Object, default: null },
  teamName: { type: Function, default: () => '' }
})
const emit = defineEmits([
  'activate',
  'context',
  'toggle-expanded',
  'focus-pane',
  'row-context',
  'toggle-read',
  'pick',
  'port-open',
  'port-copy',
  'port-stop'
])

const card = computed(() => props.card)
const rows = computed(() => card.value.panes)
const hasPorts = computed(() => props.showPorts && props.ports.length > 0)
// Orca: the branch shows under the title unless compact cards repeat it.
const showBranch = computed(() => !!card.value.branch && (!props.compactCards || card.value.branch !== card.value.title))
const hasMetaRow = computed(() =>
  props.compactCards ? false : !!(showBranch.value || hasPorts.value || props.showProjectBadge)
)
const showTitleRowIndicators = computed(() => props.compactCards && hasPorts.value)
const showInlineAgents = computed(() => props.showAgents && rows.value.length > 0)
const titleOnly = computed(() => !hasMetaRow.value && !showInlineAgents.value)
const statusGlyph = computed(() => (card.value.sleeping ? 'sleeping' : card.value.status))
const statusLabel = computed(() =>
  card.value.sleeping ? t('sidebar.status.sleeping', 'Sleeping') : getWorktreeStatusLabel(card.value.status)
)
const unreadTooltip = computed(() =>
  card.value.isUnread
    ? t('sidebar.card.markReadTooltip', 'Mark as read · {{status}}', { status: statusLabel.value })
    : t('sidebar.card.markUnreadTooltip', '{{status}} · Mark as unread', { status: statusLabel.value })
)

// Compact agent activity: several rows fold into one summary line (Orca).
const subjectLabel = computed(() => {
  const n = rows.value.length
  const agents = rows.value.filter((r) => r.kind === 'agent').length
  if (agents === n) return t('sidebar.card.agents', '{{count}} agents', { count: n })
  if (agents === 0) return t('sidebar.card.terminals', '{{count}} terminals', { count: n })
  return t('sidebar.card.panes', '{{count}} panes', { count: n })
})
const useSummary = computed(() => props.agentMode === 'compact' && rows.value.length > 1 && !(props.picking && props.picking.active))
const summary = computed(() => summarizeAgents(rows.value, subjectLabel.value))
const summaryGroups = computed(() => {
  const groups = buildSummaryAgentGroups(rows.value)
  const visible = groups.slice(0, 3).map((g) => {
    const icons = selectSummaryGroupIconAgents(g.agents, 3)
    return { ...g, icons, hidden: Math.max(0, g.agents.length - icons.length) }
  })
  const hiddenCount = groups.slice(3).reduce((n, g) => n + g.agents.length, 0)
  return { visible, hiddenCount }
})

function rowTitle(r) {
  const parts = [r.secondary ? `${r.primary} - ${r.secondary}` : r.primary]
  if (r.team)
    parts.push(
      r.lead
        ? t('sidebar.card.teamLead', 'Team: {{team}} (lead)', { team: props.teamName(r.team) })
        : t('sidebar.card.team', 'Team: {{team}}', { team: props.teamName(r.team) })
    )
  if (r.num) parts.push(t('sidebar.card.pane', 'Pane {{num}}', { num: r.num }))
  return parts.join('\n')
}

function onRow(r) {
  if (props.picking && props.picking.active) {
    if (props.picking.canPick(r)) emit('pick', r.id)
    return
  }
  emit('focus-pane', r.id)
}

function onCardClick(e) {
  if (e.defaultPrevented) return
  emit('activate', card.value)
}
</script>

<template>
  <div
    class="wtc-row"
    role="option"
    :aria-selected="card.isActive"
    :aria-current="card.isActive ? 'page' : undefined"
    :data-card-key="card.key"
  >
    <div
      class="wtc-surface"
      :class="{
        'wtc-title-only': titleOnly,
        'wtc-grouped': grouped,
        'wtc-sleeping': card.sleeping
      }"
      data-worktree-card-surface="true"
      :data-worktree-card-active="card.isActive ? 'primary' : undefined"
      @click="onCardClick"
      @contextmenu.prevent.stop="emit('context', card, $event)"
    >
      <div class="wtc-parent" :class="{ center: titleOnly }">
        <!-- Status lane: status glyph; hover shows the bell (mark read/unread). -->
        <div class="wtc-status-slot">
          <button
            type="button"
            class="wtc-unread"
            :class="{ unread: card.isUnread }"
            :aria-label="card.isUnread ? t('sidebar.card.markRead', 'Mark as read') : t('sidebar.card.markUnread', 'Mark as unread')"
            :title="unreadTooltip"
            @click.stop="emit('toggle-read', card)"
          >
            <svg v-if="card.isUnread" class="wtc-filled-bell" viewBox="0 0 24 24" aria-hidden="true">
              <path
                fill="currentColor"
                fill-rule="evenodd"
                clip-rule="evenodd"
                d="M5.25 9A6.75 6.75 0 0 1 12 2.25 6.75 6.75 0 0 1 18.75 9v3.75c0 .526.214 1.03.594 1.407l.53.532a.75.75 0 0 1-.53 1.28H4.656a.75.75 0 0 1-.53-1.28l.53-.532A1.989 1.989 0 0 0 5.25 12.75V9Zm6.75 12a3 3 0 0 0 2.996-2.825.75.75 0 0 0-.748-.8h-4.5a.75.75 0 0 0-.748.8A3 3 0 0 0 12 21Z"
              />
            </svg>
            <template v-else>
              <AgentStateDot :state="statusGlyph" variant="status" title="" class="wtc-status-glyph" />
              <Bell class="wtc-bell-hover" :size="12" aria-hidden="true" />
            </template>
          </button>
          <span class="sr-only">{{ statusLabel }}</span>
        </div>

        <div class="wtc-content" :class="{ visible: showInlineAgents }">
          <div class="wtc-identity">
            <div class="wtc-header">
              <div class="wtc-header-main">
                <span class="wtc-title" :class="{ unread: card.isUnread }" :title="card.path || card.title">
                  <span v-if="card.isUnread" class="sr-only">{{ t('sidebar.card.unread', 'Unread:') }}</span>{{ card.title }}
                </span>
                <span
                  v-if="!compactCards && card.isMain && card.branch"
                  class="wtc-badge"
                  :title="t('sidebar.card.primaryHint', 'Primary worktree (original clone directory)')"
                  >{{ t('sidebar.card.primary', 'primary') }}</span
                >
                <span v-if="showTitleRowIndicators" class="wtc-title-indicators">
                  <WorktreeCardPorts
                    :ports="ports"
                    @open="emit('port-open', $event)"
                    @copy="emit('port-copy', $event)"
                    @stop="emit('port-stop', $event)"
                  />
                </span>
              </div>
            </div>
            <div v-if="hasMetaRow" class="wtc-meta" data-worktree-card-meta-row="">
              <div class="wtc-meta-main">
                <span v-if="showProjectBadge" class="wtc-repo-badge">
                  <span class="wtc-repo-dot"></span>
                  <span class="wtc-repo-name">{{ projectName }}</span>
                </span>
                <span v-if="showBranch" class="wtc-branch" :title="card.path ? `${card.branch}\n${card.path}` : card.branch">{{
                  card.branch
                }}</span>
              </div>
              <div v-if="hasPorts" class="wtc-meta-details">
                <WorktreeCardPorts
                  :ports="ports"
                  @open="emit('port-open', $event)"
                  @copy="emit('port-copy', $event)"
                  @stop="emit('port-stop', $event)"
                />
              </div>
            </div>
          </div>

          <!-- Agents and terminals in this workspace (Orca's inline agent list). -->
          <div
            v-if="showInlineAgents"
            class="wtc-agents"
            :class="{ 'no-meta': !hasMetaRow }"
            role="group"
            :aria-label="t('sidebar.card.agentsLabel', 'Agents')"
            data-compact-agent-list="true"
            @click.stop
            @dblclick.stop
          >
            <div v-if="useSummary" class="compact-agent-summary-panel" :class="{ 'compact-agent-summary-panel-expanded': expanded }">
              <button
                type="button"
                class="compact-agent-summary-button"
                :class="{ expanded }"
                :aria-label="
                  expanded
                    ? t('sidebar.card.collapse', 'Collapse {{subject}}', { subject: subjectLabel })
                    : t('sidebar.card.expand', 'Expand {{summary}}. {{identities}}', { summary, identities: summarizeAgentIdentities(rows) })
                "
                :aria-expanded="expanded"
                :title="expanded ? '' : summary"
                @click.stop="emit('toggle-expanded', card.key)"
              >
                <span v-if="expanded" class="cas-subject">{{ subjectLabel }}</span>
                <template v-else>
                  <span class="cas-groups" aria-hidden="true">
                    <span v-for="g in summaryGroups.visible" :key="g.state" class="cas-group">
                      <AgentStateDot :state="g.state" />
                      <span class="cas-icons">
                        <span v-for="a in g.icons" :key="a.id" class="cas-icon">
                          <BrandIcon :kind="a.iconKind" :accent="a.accent" :label="a.kind === 'agent' ? a.title : null" :size="13" />
                        </span>
                      </span>
                      <span v-if="g.hidden > 0" class="cas-more">+{{ g.hidden }}</span>
                    </span>
                  </span>
                  <span v-if="summaryGroups.hiddenCount > 0" class="cas-more">+{{ summaryGroups.hiddenCount }}</span>
                </template>
                <ChevronDown class="cas-chevron" :class="{ collapsed: !expanded }" :size="12" aria-hidden="true" />
              </button>
              <div class="compact-agent-expansion-grid" :class="{ 'compact-agent-expansion-grid-expanded': expanded }" :inert="!expanded">
                <div class="cae-clip">
                  <div v-if="expanded" class="compact-agent-expansion-content">
                    <CompactAgentRow
                      v-for="r in rows"
                      :key="r.id"
                      :row="r"
                      :picking="!!(picking && picking.active)"
                      :picked="!!(picking && picking.picked.includes(r.id))"
                      :pickable="!picking || !picking.active || picking.canPick(r)"
                      :title="picking && picking.active ? picking.why(r) : rowTitle(r)"
                      @activate="onRow(r, $event)"
                      @context="(row, e) => emit('row-context', row, card, e)"
                      />
                  </div>
                </div>
              </div>
            </div>
            <template v-else>
              <CompactAgentRow
                v-for="r in rows"
                :key="r.id"
                :row="r"
                :picking="!!(picking && picking.active)"
                :picked="!!(picking && picking.picked.includes(r.id))"
                :pickable="!picking || !picking.active || picking.canPick(r)"
                :title="picking && picking.active ? picking.why(r) : rowTitle(r)"
                @activate="onRow(r, $event)"
                @context="(row, e) => emit('row-context', row, card, e)"
                />
            </template>
          </div>
        </div>
      </div>
    </div>
  </div>
                </template>
