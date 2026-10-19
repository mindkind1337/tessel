<script setup>
// Settings > MCP servers > Catalog: popular servers in two panes, the list
// (searchable, "Added ✓" on the ones every agent has) and the chosen one's
// details (what it does, what it needs, its docs), with the add bar always
// in view at the bottom. Ticking several servers adds them in one go.
import { ref, reactive, computed } from 'vue'
import { Check, Copy, ExternalLink } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import McpAddBar from './McpAddBar.vue'
import { MCP_CATALOG, MCP_CATEGORIES, catalogSpec, categoryLabel, catalogDocs } from '../../mcpCatalog'
import { t } from '../../i18n'
import { AGENT_NAME, agentList, copyText, openLink } from './mcpShared'

const props = defineProps({
  m: { type: Object, required: true }, // useMcpState()
  cwd: { type: String, default: null }
})
const emit = defineEmits(['tools'])

const needsToolLabel = (entry) =>
  t('mcp.catalog.needsTool', "This server needs {{tool}}, which isn't installed.", { tool: entry.requires === 'uvx' ? 'uv' : 'Node.js' })
const addEntryLabel = (entry) => t('mcp.catalog.addEntry', 'Add {{name}}', { name: entry.name })
const addCountLabel = (count) => t('mcp.catalog.addCount', 'Add {{count}} servers', { count })
const selectLabel = (entry) => t('mcp.catalog.select', 'Select {{name}} to add it with others', { name: entry.name })
const inSomeLabel = (count, total) => t('mcp.catalog.inSome', 'In {{count}}/{{total}}', { count, total })
const enterForLabel = (entry, input) => t('mcp.catalog.enterFor', '{{name}}: enter {{field}}.', { name: entry.name, field: input.label })
const hasItLabel = (agent) => t('mcp.catalog.hasIt', '{{agent}} already has it', { agent: AGENT_NAME[agent] })

const query = ref('')
const category = ref('All')
const viewId = ref(null)
const checked = reactive({}) // entry id -> ticked for a batch add
const answers = reactive({}) // entry id -> { input key -> value }
const submitted = reactive({}) // entry id -> Add was tried (shows what is missing)
const results = reactive({}) // entry id -> { agent: { state, error } }
const targets = reactive({}) // agent -> chosen in the add bar (all, at first)
const scope = ref('user')
const formError = ref('')
const copied = ref(false)

const filtered = computed(() => {
  const q = query.value.trim().toLowerCase()
  return MCP_CATALOG.filter(
    (e) =>
      (category.value === 'All' || e.category === category.value) &&
      (!q || `${e.name} ${e.desc} ${e.category} ${categoryLabel(e.category)}`.toLowerCase().includes(q))
  )
})
const viewed = computed(() => MCP_CATALOG.find((e) => e.id === viewId.value) || filtered.value[0] || null)
const checkedEntries = computed(() => MCP_CATALOG.filter((e) => checked[e.id]))
// What Add adds: the ticked servers, else the one shown.
const batch = computed(() => (checkedEntries.value.length ? checkedEntries.value : viewed.value ? [viewed.value] : []))
const addLabel = computed(() => {
  const list = batch.value
  if (list.length === 1) return addEntryLabel(list[0])
  return addCountLabel(list.length)
})
const agents = computed(() => props.m.addable)
// The agents that cannot be chosen: unreadable settings, and for one server
// the agents that already have it.
const blocked = computed(() => {
  if (batch.value.length !== 1) return props.m.unwritable
  const has = props.m.addedTo(batch.value[0].id)
  return { ...props.m.unwritable, ...Object.fromEntries(agents.value.filter((a) => has.includes(a)).map((a) => [a, hasItLabel(a)])) }
})
const nothingToAdd = computed(() => batch.value.every((e) => props.m.fullyAdded(e.id)))

const isOn = (a) => targets[a] !== false // on until turned off
const chipTargets = computed(() => Object.fromEntries(agents.value.map((a) => [a, isOn(a)])))
function toggleTarget(a) {
  targets[a] = !isOn(a)
}

function answersOf(entry) {
  if (!answers[entry.id]) {
    answers[entry.id] = Object.fromEntries((entry.inputs || []).map((i) => [i.key, i.kind === 'folder' ? props.cwd || '' : '']))
  }
  return answers[entry.id]
}
function view(entry) {
  viewId.value = entry.id
  answersOf(entry)
}
function clearChecked() {
  for (const k of Object.keys(checked)) delete checked[k]
}
function toggleCheck(entry) {
  if (props.m.fullyAdded(entry.id)) return
  checked[entry.id] = !checked[entry.id]
  answersOf(entry)
}
// Up and Down move between the servers of the list.
function listKeys(e) {
  if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp') return
  const all = [...e.currentTarget.closest('.mcpc-list').querySelectorAll('.mcpc-row')]
  const next = all[all.indexOf(e.currentTarget) + (e.key === 'ArrowDown' ? 1 : -1)]
  if (next) {
    e.preventDefault()
    next.focus()
    next.click()
  }
}

const neededHere = (input, chosen) => input.as !== 'header' || chosen.includes('claude')
const missing = (entry, input) =>
  submitted[entry.id] && neededHere(input, agents.value.filter(isOn)) && !String(answersOf(entry)[input.key] || '').trim()

async function browse(entry, key) {
  const picked = await window.shellApi.pickFolder({
    title: t('mcp.catalog.chooseFolder', 'Choose a folder'),
    defaultPath: answersOf(entry)[key] || props.cwd || undefined
  })
  if (picked) answersOf(entry)[key] = picked
}

async function copyCommand(entry) {
  if (await copyText(entry.transport === 'http' ? entry.url : entry.command)) {
    copied.value = true
    setTimeout(() => (copied.value = false), 1500)
  }
}

async function add() {
  const m = props.m
  formError.value = ''
  const chosen = agents.value.filter((a) => isOn(a) && !blocked.value[a])
  if (!chosen.length) {
    formError.value = t('mcp.chooseAgent', 'Choose at least one agent.')
    return
  }
  const list = batch.value.filter((e) => !m.fullyAdded(e.id))
  // Everything a server needs, before adding any: the first one missing an
  // answer is shown, with what it lacks.
  for (const entry of list) {
    const lack = (entry.inputs || []).find((i) => neededHere(i, chosen) && !String(answersOf(entry)[i.key] || '').trim())
    if (lack) {
      submitted[entry.id] = true
      viewId.value = entry.id
      formError.value = enterForLabel(entry, lack)
      return
    }
  }
  m.busy = 'add:catalog'
  const added = []
  try {
    for (const entry of list) {
      const to = chosen.filter((a) => !m.addedTo(entry.id).includes(a) && !m.unwritable[a])
      if (!to.length) continue
      const out = await m.addToAgents(to, (agent) => ({
        ...catalogSpec(entry, answersOf(entry), agent),
        scope: agent === 'claude' ? scope.value : 'user',
        cwd: props.cwd
      }))
      results[entry.id] = out
      if (m.addedNames(out).length) added.push(entry)
    }
  } finally {
    m.busy = ''
  }
  const failed = list.filter((e) => results[e.id] && m.failuresText(results[e.id]))
  if (failed.length) formError.value = t('mcp.catalog.someFailed', 'Not added everywhere: the details of each server say why.')
  if (!added.length) return
  const names = agentList(added.map((e) => e.name))
  const agentsDone = agentList([...new Set(added.flatMap((e) => m.addedNames(results[e.id])))])
  const vars = { name: names, agents: agentsDone }
  m.say(
    added.some((e) => e.auth === 'oauth')
      ? t('mcp.catalog.addedOauth', 'Added {{name}} to {{agents}}. It asks you to sign in the first time an agent uses it. Restart running agent panes to load it.', vars)
      : t('mcp.catalog.added', 'Added {{name}} to {{agents}}. Restart running agent panes to load it.', vars)
  )
  for (const e of added) if (!failed.includes(e)) delete checked[e.id]
  // Each agent's test: one that answers only after a sign-in says so.
  for (const e of added) {
    await m.checkAdded(e.id, results[e.id])
    results[e.id] = { ...results[e.id] }
  }
}

const RESULT = {
  added: { cls: 'tag-ok', label: () => t('mcp.catalog.addedTag', 'Added') },
  auth: { cls: 'tag-warn', label: () => t('mcp.test.needsSignIn', 'Needs sign-in') },
  failed: { cls: 'tag-danger', label: () => t('mcp.test.failed', 'Failed') }
}
</script>

<template>
  <div class="mcpc">
    <div class="mcpc-panes">
      <div class="mcpc-browse">
        <input
          v-model="query"
          type="search"
          class="set-number mcpc-search"
          :placeholder="t('mcp.catalog.search', 'Search servers')"
          :aria-label="t('mcp.catalog.search', 'Search servers')"
          spellcheck="false"
        />
        <div class="mcpc-cats" role="group" :aria-label="t('mcp.catalog.categories', 'Categories')">
          <button
            v-for="c in MCP_CATEGORIES"
            :key="c"
            type="button"
            class="chip"
            :class="{ on: category === c }"
            :aria-pressed="category === c ? 'true' : 'false'"
            @click="category = c"
          >
            {{ categoryLabel(c) }}
          </button>
        </div>
        <ul class="mcpc-list" :aria-label="t('mcp.tab.catalog', 'Catalog')">
          <li
            v-for="entry in filtered"
            :key="entry.id"
            class="mcpc-item"
            :class="{ viewed: viewed && viewed.id === entry.id, checked: checked[entry.id] }"
            :data-entry="entry.id"
          >
            <button
              type="button"
              role="checkbox"
              class="mcpc-check"
              :aria-checked="checked[entry.id] ? 'true' : 'false'"
              :aria-label="selectLabel(entry)"
              :title="selectLabel(entry)"
              :disabled="m.fullyAdded(entry.id)"
              @click="toggleCheck(entry)"
            >
              <Check v-if="checked[entry.id] || m.fullyAdded(entry.id)" :size="11" aria-hidden="true" />
            </button>
            <button
              type="button"
              class="mcpc-row"
              :aria-current="viewed && viewed.id === entry.id ? 'true' : undefined"
              @click="view(entry)"
              @keydown="listKeys"
            >
              <span class="mcpc-icon"><BrandIcon :kind="'mcp-' + entry.id" :accent="entry.accent" :label="entry.name" :size="20" /></span>
              <span class="mcpc-row-main">
                <span class="mcpc-row-name">{{ entry.name }}</span>
                <span class="mcpc-row-desc">{{ entry.desc }}</span>
              </span>
              <span v-if="m.fullyAdded(entry.id)" class="tag tag-ok mcpc-added">{{ t('mcp.catalog.addedMark', 'Added ✓') }}</span>
              <span
                v-else-if="m.addedTo(entry.id).length"
                class="tag"
                :title="agentList(m.addedTo(entry.id).map((a) => AGENT_NAME[a]))"
                >{{ inSomeLabel(m.addedTo(entry.id).length, m.writable.length) }}</span
              >
            </button>
          </li>
        </ul>
        <p v-if="!filtered.length" class="mcpc-none">{{ t('mcp.catalog.noMatch', 'No servers match. Try the Custom tab.') }}</p>
      </div>

      <section v-if="viewed" class="mcpc-detail" :aria-label="viewed.name" aria-live="polite">
        <header class="mcpc-detail-head">
          <BrandIcon :kind="'mcp-' + viewed.id" :accent="viewed.accent" :label="viewed.name" :size="28" />
          <div class="mcpc-detail-title">
            <h3>{{ viewed.name }}</h3>
            <span class="mcpc-detail-tags">
              <span class="tag">{{ categoryLabel(viewed.category) }}</span>
              <span class="tag tag-scope">{{ viewed.transport }}</span>
              <span v-if="viewed.auth === 'oauth'" class="tag tag-info">{{ t('mcp.catalog.signInTag', 'Sign-in') }}</span>
              <span v-if="m.fullyAdded(viewed.id)" class="tag tag-ok">{{ t('mcp.catalog.addedMark', 'Added ✓') }}</span>
            </span>
          </div>
        </header>
        <p class="mcpc-desc">{{ viewed.desc }}</p>
        <p v-if="viewed.auth === 'oauth'" class="set-hint mcpc-note">
          {{ t('mcp.catalog.oauthNote', 'It asks you to sign in the first time an agent uses it.') }}
        </p>

        <div v-if="viewed.requires && m.haveCmd[viewed.requires] === false" class="set-callout warn">
          <span class="set-callout-text">{{ needsToolLabel(viewed) }}</span>
          <button type="button" class="exit-btn small" @click="emit('tools')">{{ t('mcp.catalog.openTools', 'Open Tools') }}</button>
        </div>

        <div v-for="input in viewed.inputs || []" :key="input.key" class="mcpc-field">
          <label :for="'mcpc-' + viewed.id + '-' + input.key">{{ input.label }}</label>
          <div class="mcpc-input-wrap">
            <input
              :id="'mcpc-' + viewed.id + '-' + input.key"
              v-model="answersOf(viewed)[input.key]"
              class="set-number mcpc-input"
              :class="{ invalid: missing(viewed, input) }"
              :type="input.kind === 'secret' ? 'password' : 'text'"
              :aria-invalid="missing(viewed, input) ? 'true' : 'false'"
              spellcheck="false"
              autocomplete="off"
            />
            <button v-if="input.kind === 'folder'" type="button" class="exit-btn" @click="browse(viewed, input.key)">
              {{ t('mcp.catalog.browse', 'Browse') }}
            </button>
          </div>
          <span v-if="missing(viewed, input)" class="mcpc-invalid" role="alert">{{ t('mcp.catalog.required', 'Required') }}</span>
          <span v-else-if="input.help" class="set-hint">{{ input.help }}</span>
        </div>

        <dl class="mcpc-facts">
          <dt>{{ viewed.transport === 'http' ? t('mcp.installed.connects', 'Connects to') : t('mcp.installed.runs', 'Runs') }}</dt>
          <dd>
            <span class="sl-path" :title="viewed.transport === 'http' ? viewed.url : viewed.command">{{ viewed.transport === 'http' ? viewed.url : viewed.command }}</span>
            <button type="button" class="tb-icon mcpc-copy" :aria-label="t('mcp.catalog.copy', 'Copy')" :title="t('mcp.catalog.copy', 'Copy')" @click="copyCommand(viewed)">
              <Check v-if="copied" :size="12" aria-hidden="true" />
              <Copy v-else :size="12" aria-hidden="true" />
            </button>
          </dd>
          <template v-if="m.addedTo(viewed.id).length">
            <dt>{{ t('mcp.catalog.alreadyIn', 'Already in') }}</dt>
            <dd class="mcpc-has">
              <span v-for="a in m.addedTo(viewed.id)" :key="a" class="mcpc-has-agent"><BrandIcon :kind="a" :size="13" />{{ AGENT_NAME[a] }}</span>
            </dd>
          </template>
        </dl>
        <button v-if="catalogDocs(viewed)" type="button" class="sl-link mcpc-docs" @click="openLink(catalogDocs(viewed), $event)">
          {{ t('mcp.catalog.docs', 'Documentation') }}<ExternalLink :size="11" aria-hidden="true" />
        </button>

        <ul v-if="results[viewed.id]" class="sl-subs mcpc-results">
          <li v-for="(r, agent) in results[viewed.id]" :key="agent" class="sl-sub" :data-agent="agent">
            <div class="sl-sub-line">
              <BrandIcon :kind="agent" :size="14" />
              <span>{{ AGENT_NAME[agent] }}</span>
              <span class="tag mcpc-result" :class="RESULT[r.state].cls">{{ RESULT[r.state].label() }}</span>
              <span class="sl-actions">
                <button v-if="r.state === 'auth'" type="button" class="exit-btn small" @click="m.signIn(agent, viewed.id)">
                  {{ t('mcp.installed.signIn', 'Sign in') }}
                </button>
              </span>
            </div>
            <details v-if="r.state === 'failed' && r.error" class="set-more mcpc-raw">
              <summary>{{ t('mcp.details', 'Details') }}</summary>
              <p>{{ r.error }}</p>
            </details>
          </li>
        </ul>
      </section>
    </div>

    <McpAddBar
      v-model:scope="scope"
      :agents="agents"
      :targets="chipTargets"
      :blocked="blocked"
      :cwd="cwd"
      :label="addLabel"
      :busy="m.busy === 'add:catalog'"
      :disabled="!!m.busy || !batch.length || nothingToAdd"
      :error="formError"
      @toggle="toggleTarget"
      @add="add"
    >
      <template #secondary>
        <span v-if="checkedEntries.length" class="set-hint mcpc-batch">
          <button type="button" class="sl-link" @click="clearChecked">
            {{ t('mcp.catalog.clearSelection', 'Clear selection') }}
          </button>
        </span>
      </template>
    </McpAddBar>
  </div>
</template>

<style scoped>
.mcpc {
  container-type: inline-size;
  margin-top: 10px;
}
.mcpc-panes {
  display: grid;
  grid-template-columns: minmax(0, 5fr) minmax(0, 6fr);
  gap: 14px;
  align-items: start;
}
.mcpc-browse {
  display: flex;
  flex-direction: column;
  gap: 8px;
  min-width: 0;
}
.mcpc-search {
  width: 100%;
  height: 28px;
  text-align: left;
}
.mcpc-cats {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mcpc-list {
  max-height: 440px;
  margin: 0;
  padding: 0;
  overflow-y: auto;
  border-top: 1px solid var(--border);
  list-style: none;
}
.mcpc-item {
  display: flex;
  align-items: center;
  gap: 2px;
  border-bottom: 1px solid var(--border);
}
.mcpc-check {
  display: inline-flex;
  flex: 0 0 auto;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  margin: 0 4px 0 6px;
  padding: 0;
  border: 1px solid var(--border-strong);
  border-radius: 4px;
  background: transparent;
  color: var(--text-strong);
  cursor: pointer;
}
.mcpc-check[aria-checked='true'] {
  border-color: var(--accent);
  background: var(--accent);
  color: #fff;
}
.mcpc-check:disabled {
  border-color: transparent;
  color: #3fb950;
  cursor: default;
}
.mcpc-check:focus-visible,
.mcpc-row:focus-visible {
  outline: 2px solid var(--accent);
  outline-offset: -2px;
}
.mcpc-row {
  display: flex;
  flex: 1 1 auto;
  align-items: center;
  gap: 9px;
  min-width: 0;
  min-height: 44px;
  padding: 5px 8px 5px 4px;
  border: 0;
  border-radius: 6px;
  background: transparent;
  color: var(--text);
  font: inherit;
  text-align: left;
  cursor: pointer;
}
.mcpc-row:hover,
.mcpc-item.viewed .mcpc-row {
  background: var(--surface-3);
}
.mcpc-item.viewed .mcpc-row {
  box-shadow: inset 2px 0 0 var(--accent);
}
/* Every icon in the same box, so the names line up. */
.mcpc-icon {
  display: inline-flex;
  flex: 0 0 22px;
  justify-content: center;
}
.mcpc-row-main {
  display: flex;
  flex: 1 1 auto;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
}
.mcpc-row-name {
  color: var(--text-strong);
  font-size: 12.5px;
  font-weight: 600;
}
.mcpc-row-desc {
  overflow: hidden;
  color: var(--text-dim);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.mcpc-none {
  margin: 4px 0;
  color: var(--text-dim);
  font-size: 12px;
}
.mcpc-detail {
  display: flex;
  flex-direction: column;
  gap: 10px;
  min-width: 0;
  padding: 12px 14px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.mcpc-detail-head {
  display: flex;
  align-items: center;
  gap: 10px;
}
.mcpc-detail-title {
  display: flex;
  flex-direction: column;
  gap: 3px;
  min-width: 0;
}
.mcpc-detail-title h3 {
  margin: 0;
  color: var(--text-strong);
  font-size: 15px;
  font-weight: 600;
}
.mcpc-detail-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.mcpc-desc {
  margin: 0;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.5;
}
.mcpc-note {
  margin: -4px 0 0;
}
.mcpc-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.mcpc-field label {
  color: var(--text-strong);
  font-size: 12px;
}
.mcpc-input-wrap {
  display: flex;
  gap: 6px;
}
.mcpc-input {
  flex: 1 1 auto;
  width: auto;
  min-width: 0;
  height: 28px;
  text-align: left;
}
.mcpc-input.invalid {
  border-color: var(--danger);
}
.mcpc-invalid {
  color: #ffb4b6;
  font-size: 11.5px;
}
.mcpc-facts {
  display: grid;
  grid-template-columns: auto minmax(0, 1fr);
  align-items: center;
  gap: 4px 12px;
  margin: 0;
  font-size: 11.5px;
}
.mcpc-facts dt {
  color: var(--text-dim);
  white-space: nowrap;
}
.mcpc-facts dd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 4px 10px;
  min-width: 0;
  margin: 0;
}
.mcpc-facts dd:first-of-type {
  flex-wrap: nowrap;
}
.mcpc-copy {
  flex: 0 0 auto;
  width: 22px;
  height: 22px;
}
.mcpc-has-agent {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.mcpc-docs {
  display: inline-flex;
  align-self: flex-start;
  align-items: center;
  gap: 4px;
  font-size: 12px;
}
.mcpc-raw p {
  margin: 4px 0 0;
  font-family: 'Cascadia Mono', Consolas, monospace;
  font-size: 10.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  user-select: text;
}
.mcpc-batch {
  font-size: 11px;
}
/* Narrow (a small window, or zoomed in): the list above, the details under
   it, the list shorter so both show. */
@container (max-width: 600px) {
  .mcpc-panes {
    grid-template-columns: minmax(0, 1fr);
  }
  .mcpc-list {
    max-height: 250px;
  }
}
</style>
