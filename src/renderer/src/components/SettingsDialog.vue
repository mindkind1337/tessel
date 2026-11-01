<script setup>
// Settings, as a full page over the app's main area (like Orca's): a sidebar
// with "Back to app", a search box and the pages, then one page at a time.
// Edits the shared `settings` store directly, so every change applies live to
// all panes and is saved automatically.
// Each page is its own component in ./settings (SettingsGeneral.vue, …, see
// its README.md); this file is the shell: the sidebar, the search and which
// page shows.
import { t } from '../i18n'
import { ref, computed, watch, nextTick, onMounted, onUnmounted, onUpdated, provide, toRef } from 'vue'
import { BarChart3 } from 'lucide-vue-next'
import { PAGES, GROUPS, PAGE_TITLES_EN, PAGE_ALIASES } from './settings/settingsPages'
import { SETTINGS_SHELL } from './settings/settingsShell'
import SettingsStats from './settings/SettingsStats.vue'
import SettingsAgents from './settings/SettingsAgents.vue'
import SettingsAccounts from './settings/SettingsAccounts.vue'
import SettingsSkills from './settings/SettingsSkills.vue'
import SettingsMcp from './settings/SettingsMcp.vue'
import SettingsConnections from './settings/SettingsConnections.vue'
import SettingsContext from './settings/SettingsContext.vue'
import SettingsOrchestration from './settings/SettingsOrchestration.vue'
import SettingsVoice from './settings/SettingsVoice.vue'
import SettingsGeneral from './settings/SettingsGeneral.vue'
import SettingsAppearance from './settings/SettingsAppearance.vue'
import SettingsTerminal from './settings/SettingsTerminal.vue'
import SettingsNotifications from './settings/SettingsNotifications.vue'
import SettingsEditor from './settings/SettingsEditor.vue'
import SettingsBrowser from './settings/SettingsBrowser.vue'
import SettingsGit from './settings/SettingsGit.vue'
import SettingsDevtools from './settings/SettingsDevtools.vue'
import SettingsAutomations from './settings/SettingsAutomations.vue'
import SettingsQuickCommands from './settings/SettingsQuickCommands.vue'
import SettingsSsh from './settings/SettingsSsh.vue'
import SettingsUpdates from './settings/SettingsUpdates.vue'

const props = defineProps({
  shells: { type: Array, default: () => [] },
  // Built-in and your own agents, with `available` (found on the PATH).
  agents: { type: Array, default: () => [] },
  worktreePaths: { type: Array, default: () => [] },
  // The current workspace's project folder (the Skills and MCP servers pages).
  projectCwd: { type: String, default: null },
  defaultShell: { type: String, default: null },
  updateStatus: { type: Object, default: () => ({ state: 'disabled' }) },
  // Open on this page, e.g. 'quick-commands', 'accounts', 'agents'.
  section: { type: String, default: null },
  // ...scrolled to this part of it (an element id there, e.g. 'set-signed-in').
  anchor: { type: String, default: null },
  // Agent CLI updates: { checkedAt, agents: { id: { installed, latest,
  // update, source, note } } }, the updates running (agentId -> job) and
  // the ones waiting their turn.
  agentUpdates: { type: Object, default: null },
  agentUpdateJobs: { type: Object, default: () => ({}) },
  agentUpdateQueue: { type: Array, default: () => [] },
  // { entries: [...newest first], last: { agentId: entry } } (main's agentUpdateHistory.js)
  agentUpdateHistory: { type: Object, default: () => ({ entries: [], last: {} }) }
})

const PAGE_KEY = 'tessel.settingsPage'

// A page's id now, for an old one that moved (PAGE_ALIASES: 'text' is Terminal).
const pageId = (id) => (PAGE_ALIASES[id] ? PAGE_ALIASES[id].page : id)

function storedPage() {
  try {
    const p = pageId(localStorage.getItem(PAGE_KEY))
    return PAGES[p] ? p : null
  } catch {
    return null
  }
}
const page = ref((PAGES[pageId(props.section)] && pageId(props.section)) || storedPage() || 'general')
const query = ref('')
const searching = computed(() => !!query.value.trim())
const matched = ref([]) // the pages with a match for the search
const mainEl = ref(null)
const searchEl = ref(null)
// The tab the MCP servers page opens on: 'connections' from Orchestration's
// Details, else 'installed'.
const mcpTab = ref('installed')

function go(id) {
  id = pageId(id)
  if (!PAGES[id]) return
  if (id !== 'mcp') mcpTab.value = 'installed'
  page.value = id
  query.value = ''
  try {
    localStorage.setItem(PAGE_KEY, id)
  } catch {
    // no storage (private window): the page is just not remembered
  }
  if (mainEl.value) mainEl.value.scrollTop = 0
}
watch(
  () => props.section,
  (s) => s && go(s)
)
// Opened on a part of a page (the usage menu's Where you're signed in…), or
// on a page that moved into another (its old id scrolls to where it is now).
function scrollToAnchor() {
  const id = props.anchor || PAGE_ALIASES[props.section]?.anchor
  if (!id || !/^[\w-]{1,60}$/.test(id)) return
  nextTick(() => {
    const el = mainEl.value && mainEl.value.querySelector(`#${id}`)
    if (el && typeof el.scrollIntoView === 'function') el.scrollIntoView({ block: 'start' })
  })
}
watch(() => [props.section, props.anchor], scrollToAnchor)
onMounted(scrollToAnchor)
function openMcpTab(tab) {
  go('mcp')
  mcpTab.value = tab
}
function shown(id) {
  return searching.value ? matched.value.includes(id) : page.value === id
}

// Search: shows the rows that match across all pages (every word, any case),
// under their page's title. Works on the rendered text, so it finds a
// setting by its label, hint or choices in the interface's language; a
// page's English title also finds the whole page.
const ITEM = '.set-row, .agent-set, .orch-example, .orch-tools li, .account-provider'
function words() {
  return query.value.trim().toLowerCase().split(/\s+/).filter(Boolean)
}
function has(text, ws) {
  const lower = (text || '').toLowerCase()
  return ws.every((w) => lower.includes(w))
}
function hide(el) {
  el.hidden = true
  el.setAttribute('data-sh', '')
}
function filterBlock(el, ws) {
  if (!has(el.textContent, ws)) return false
  if (el.matches(ITEM) || !el.querySelector(ITEM)) return true
  const title = el.querySelector(':scope > .set-group-title')
  if (title && has(title.textContent, ws)) return true
  let any = false
  for (const child of el.children) {
    if (child.classList.contains('set-group-title')) continue
    if (filterBlock(child, ws)) any = true
    else hide(child)
  }
  return any
}
function applySearch() {
  const root = mainEl.value
  if (!root) return
  for (const el of root.querySelectorAll('[data-sh]')) {
    el.hidden = false
    el.removeAttribute('data-sh')
  }
  const ws = words()
  const hits = []
  if (ws.length) {
    for (const pg of root.querySelectorAll('.set-page')) {
      const head = pg.querySelector('.set-page-head h2')
      let any = has(head && head.textContent, ws) || has(PAGE_TITLES_EN[pg.dataset.page], ws)
      if (!any) {
        for (const group of pg.querySelectorAll(':scope > .set-group')) {
          if (filterBlock(group, ws)) any = true
          else hide(group)
        }
      }
      if (any) hits.push(pg.dataset.page)
    }
    // A page that moved into a group (Text, now Terminal's Font): its old
    // title, or an English name of it, shows that whole group.
    for (const alias of Object.values(PAGE_ALIASES)) {
      const group = alias.anchor && root.querySelector(`#${alias.anchor}`)
      const pg = group && group.closest('.set-page')
      if (!pg || ![alias.title, ...(alias.namesEn || [])].some((name) => has(name, ws))) continue
      for (const el of [group, ...group.querySelectorAll('[data-sh]')]) {
        el.hidden = false
        el.removeAttribute('data-sh')
      }
      if (!hits.includes(pg.dataset.page)) hits.push(pg.dataset.page)
    }
  }
  if (hits.join() !== matched.value.join()) matched.value = hits
  showMatches(root, hits, ws)
}
watch(query, () => nextTick(applySearch))
onUpdated(applySearch)

// How many rows the search shows (a page found by its title counts its rows,
// one at least), and its words highlighted in them. The highlight is a CSS
// Custom Highlight (::highlight(settings-search) in style.css): nothing is
// added to the pages, whose text Vue owns.
const resultCount = ref(0)
const resultText = computed(() =>
  t('settings.search.count', resultCount.value === 1 ? '{{count}} result' : '{{count}} results', { count: resultCount.value })
)
const HIGHLIGHT = 'settings-search'
const canHighlight = () => typeof CSS !== 'undefined' && !!CSS.highlights && typeof Highlight === 'function'
function showMatches(root, hits, ws) {
  let count = 0
  const ranges = []
  for (const pg of root.querySelectorAll('.set-page')) {
    if (!hits.includes(pg.dataset.page)) continue
    const rows = [...pg.querySelectorAll(ITEM)].filter((el) => {
      const hidden = el.closest('[hidden]')
      return (!hidden || hidden === pg) && !el.parentElement.closest(ITEM)
    })
    count += Math.max(1, rows.length)
    if (!canHighlight()) continue
    // Text the page shows: what the search (or the page) hid is skipped.
    const walker = document.createTreeWalker(pg, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : n.hidden || n.tagName === 'STYLE' ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_SKIP
    })
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.data.toLowerCase()
      for (const w of ws) {
        for (let i = text.indexOf(w); i >= 0; i = text.indexOf(w, i + w.length)) {
          const range = new Range()
          range.setStart(node, i)
          range.setEnd(node, i + w.length)
          ranges.push(range)
        }
      }
    }
  }
  if (count !== resultCount.value) resultCount.value = count
  if (!canHighlight()) return
  if (ranges.length) CSS.highlights.set(HIGHLIGHT, new Highlight(...ranges))
  else CSS.highlights.delete(HIGHLIGHT)
}

function onKeydown(e) {
  if (e.ctrlKey && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'f') {
    e.preventDefault()
    e.stopPropagation()
    searchEl.value?.focus()
    searchEl.value?.select()
  }
}
function onEscape(e) {
  // Escape in the search box first empties it; otherwise it closes Settings.
  if (e.target === searchEl.value && query.value) query.value = ''
  else emit('close')
}
const emit = defineEmits([
  'close',
  'set-default-shell',
  'check-updates',
  'open-update',
  'detect-agents',
  'check-agent-updates',
  'update-agent',
  'update-all-agents',
  'cancel-agent-update',
  'update-agent-in-pane',
  'close-reopen-agent-update',
  'open-update-log',
  'test-notification',
  'install-agent',
  'agent-install-page',
  'open-cookie-import',
  // A window, panel or tool to open (settingsTools.js ids), Settings closed first.
  'open-tool',
  // A command of the Skills or MCP servers page ({ label, command }), to run
  // in a new pane once Settings is closed.
  'run-job'
])

// What every page gets from the shell (settings/settingsShell.js). A page's
// own re-render runs the search again, as this file's onUpdated does for it.
provide(SETTINGS_SHELL, { page, searching, shown, go, openMcpTab, mcpTab, anchor: toRef(props, 'anchor'), emit, refreshSearch: applySearch })

const cardEl = ref(null)
let previousFocus
const inertSiblings = []

function focusCard() {
  cardEl.value?.focus({ preventScroll: true })
}

function containFocus(event) {
  if (cardEl.value && !cardEl.value.contains(event.target)) focusCard()
}

function trapTab(event) {
  const card = cardEl.value
  const controls = [
    ...card.querySelectorAll('button, input, select, textarea, a[href], [tabindex]')
  ].filter((el) => {
    const style = getComputedStyle(el)
    return (
      el.tabIndex >= 0 &&
      !el.matches(':disabled') &&
      !el.closest('[hidden], [inert]') &&
      style.display !== 'none' &&
      style.visibility !== 'hidden'
    )
  })
  const first = controls[0]
  const last = controls.at(-1)
  if (!first || document.activeElement === card) {
    event.preventDefault()
    ;(event.shiftKey ? last : first)?.focus()
  } else if (event.shiftKey && document.activeElement === first) {
    event.preventDefault()
    last.focus()
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault()
    first.focus()
  }
}

onMounted(() => {
  previousFocus = document.activeElement
  // Make every branch outside this page inert, including live xterm inputs.
  // Keep existing inert attributes intact when Settings closes.
  // A previous Settings that never unmounted (a hot reload) leaves its marks:
  // they are lifted first, so nothing stays unclickable.
  for (const stale of document.querySelectorAll('[data-settings-inert]')) {
    stale.removeAttribute('inert')
    stale.removeAttribute('data-settings-inert')
  }
  let branch = cardEl.value
  while (branch && branch !== document.body) {
    for (const sibling of branch.parentElement?.children || []) {
      if (sibling !== branch && !sibling.hasAttribute('inert')) {
        sibling.setAttribute('inert', '')
        sibling.setAttribute('data-settings-inert', '')
        inertSiblings.push(sibling)
      }
    }
    branch = branch.parentElement
  }
  document.addEventListener('focusin', containFocus)
  focusCard()
})

onUnmounted(() => {
  document.removeEventListener('focusin', containFocus)
  for (const sibling of inertSiblings) {
    sibling.removeAttribute('inert')
    sibling.removeAttribute('data-settings-inert')
  }
  if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true })
  if (canHighlight()) CSS.highlights.delete(HIGHLIGHT)
})
</script>

<template>
  <div
    ref="cardEl"
    class="settings-page"
    :class="{ searching }"
    role="dialog"
    :aria-label="t('settings.dialog.label', 'Settings')"
    aria-modal="true"
    tabindex="-1"
    @keydown="onKeydown"
    @keydown.tab.stop="trapTab"
    @keydown.escape.prevent.stop="onEscape"
  >
    <nav class="set-side" :aria-label="t('settings.nav.pagesLabel', 'Settings pages')">
      <button class="set-back" type="button" :title="t('settings.nav.backTitle', 'Back to app (Esc)')" @click="emit('close')">
        <svg width="14" height="14" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M13 8H3.5M7.5 3.5L3 8l4.5 4.5"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
            stroke-linejoin="round"
          />
        </svg>
        {{ t('settings.nav.back', 'Back to app') }}
      </button>
      <div class="set-search">
        <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M7 12A5 5 0 107 2a5 5 0 000 10zM10.6 10.6L14 14"
            stroke="currentColor"
            stroke-width="1.5"
            stroke-linecap="round"
          />
        </svg>
        <input
          ref="searchEl"
          v-model="query"
          type="search"
          :placeholder="t('settings.search.placeholder', 'Search settings')"
          :aria-label="t('settings.search.placeholder', 'Search settings')"
          :title="t('settings.search.title', 'Search settings (Ctrl+F)')"
          spellcheck="false"
        />
      </div>
      <div v-for="g in GROUPS" :key="g.id" class="set-nav-group">
        <h3 class="set-nav-head">{{ g.title }}</h3>
        <ul class="set-nav-list">
          <li v-for="id in g.pages" :key="id">
            <button
              class="set-nav-item"
              type="button"
              :data-page="id"
              :class="{ on: !searching && page === id, dim: searching && !matched.includes(id) }"
              :aria-current="!searching && page === id ? 'page' : undefined"
              @click="go(id)"
            >
              <BarChart3 v-if="id === 'stats'" :size="15" aria-hidden="true" />
              <component :is="PAGES[id].lucide" v-else-if="PAGES[id].lucide" :size="15" aria-hidden="true" />
              <svg v-else width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                <path
                  :d="PAGES[id].icon"
                  stroke="currentColor"
                  stroke-width="1.3"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
              </svg>
              {{ PAGES[id].title }}
            </button>
          </li>
        </ul>
      </div>
    </nav>

    <main ref="mainEl" class="set-main">
      <div class="set-content" :class="{ 'set-content-wide': page === 'skills' && !searching }">
        <p
          v-if="searching && !matched.length"
          class="set-empty"
          role="status"
          v-text="t('settings.search.noMatch', 'No settings match “{{query}}”.', { query: query.trim() })"
        ></p>
        <p v-else-if="searching" class="set-count" role="status">{{ resultText }}</p>

        <SettingsAgents :shells="shells" :agents="agents" :agent-updates="agentUpdates" :agent-update-jobs="agentUpdateJobs" :agent-update-queue="agentUpdateQueue" :agent-update-history="agentUpdateHistory" />
        <SettingsAccounts />
        <SettingsSkills :agents="agents" :project-cwd="projectCwd" />
        <SettingsMcp :agents="agents" :project-cwd="projectCwd" />
        <SettingsConnections :agents="agents" :project-cwd="projectCwd" />
        <SettingsContext :agents="agents" :project-cwd="projectCwd" />
        <SettingsOrchestration :agents="agents" />
        <SettingsGeneral />
        <SettingsAppearance />
        <SettingsTerminal :shells="shells" :default-shell="defaultShell" />
        <SettingsEditor />
        <SettingsBrowser />
        <SettingsNotifications />
        <SettingsVoice />
        <SettingsGit />
        <SettingsDevtools />
        <SettingsAutomations />
        <SettingsQuickCommands />
        <SettingsSsh />
        <SettingsStats :worktree-paths="worktreePaths" />
        <SettingsUpdates :update-status="updateStatus" />
      </div>
    </main>
  </div>
</template>
