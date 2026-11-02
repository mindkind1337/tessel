<script setup>
// Settings > Connections: your accounts, for every agent. One Connect per
// service: it adds the server to the agents that lack it, then signs in. Local
// servers (Google, Microsoft) sign in once for all agents; a hosted server keeps
// one sign-in per agent, so each agent has its own Sign in. The catalog
// (mcpCatalog.js, Productivity) says what each service runs and needs.
import { reactive, onMounted, onBeforeUnmount } from 'vue'
import { Check, Copy, ExternalLink } from 'lucide-vue-next'
import BrandIcon from '../BrandIcon.vue'
import TesselConnections from './TesselConnections.vue'
import SettingsListItem from './SettingsListItem.vue'
import { useMcpState } from '../mcp/mcpState'
import { AGENT_NAME, copyText, openLink } from '../mcp/mcpShared'
import { MCP_CATALOG, catalogSpec, catalogDocs } from '../../mcpCatalog'
import { t } from '../../i18n'

const props = defineProps({
  agents: { type: Array, default: () => [] },
  cwd: { type: String, default: null }
})
const emit = defineEmits(['run', 'open-mcp', 'open-account'])
const m = useMcpState(props, emit)

const entries = MCP_CATALOG.filter((e) => e.category === 'Productivity')
const POLL_MS = 2500
const EMAIL_RE = /^[A-Za-z0-9._+-]+@[A-Za-z0-9.-]+$/
const isLocal = (entry) => entry.transport === 'stdio'
// With a Tessel account, this service needs nothing set up: Tessel's Google app is used.
const ACCOUNT_SERVICE = 'google-workspace'
const account = reactive({ signedIn: false })

const rows = reactive(
  Object.fromEntries(
    entries.map((e) => [
      e.id,
      {
        open: false,
        busy: false,
        checking: false,
        error: '',
        answers: Object.fromEntries((e.inputs || []).map((i) => [i.key, ''])),
        email: '',
        ownClient: false,
        signedIn: false, // true, false, or null when it could not be told
        account: null,
        session: null, // { id, page, code }
        copied: false
      }
    ])
  )
)
const timers = new Map()
let leftPage = false

// The package this entry runs, as a whole word of a server's command.
function runsEntry(entry, server) {
  const pkg = String(entry.command).split(/\s+/).slice(1).find((w) => !w.startsWith('-'))
  return String(server.target || '').split(/\s+/).includes(pkg)
}
// Is this agent's server of that name really this service, for all projects?
function isOurs(entry, server) {
  if (server.scope !== 'user') return false
  return isLocal(entry) ? runsEntry(entry, server) : server.target === entry.url
}
const serverOf = (entry, agent) => m.listOf(agent).find((s) => s.name === entry.id)
const has = (entry) => m.addedTo(entry.id).filter((a) => isOurs(entry, serverOf(entry, a)))
// Agents holding something else under this name: it is never copied or replaced.
const conflicts = (entry) => m.addedTo(entry.id).filter((a) => !isOurs(entry, serverOf(entry, a)))
const missing = (entry) => m.writable.filter((a) => !serverOf(entry, a))
const usesAccount = (entry) => entry.id === ACCOUNT_SERVICE && account.signedIn && !rows[entry.id].ownClient
const askInputs = (entry) => (has(entry).length || usesAccount(entry) ? [] : entry.inputs || [])

function status(entry) {
  const row = rows[entry.id]
  if (!has(entry).length) return null
  if (!isLocal(entry)) return 'added'
  if (row.checking) return 'checking'
  if (row.signedIn === null) return 'unknown'
  return row.signedIn ? 'connected' : 'signIn'
}
const STATUS = {
  checking: { cls: '', label: () => t('settings.connections.checking', 'Checking…') },
  connected: { cls: 'tag-ok', label: () => t('settings.connections.connected', 'Connected') },
  signIn: { cls: 'tag-warn', label: () => t('settings.connections.needsSignIn', 'Sign-in needed') },
  unknown: { cls: '', label: () => t('settings.connections.unknown', 'Could not check') },
  added: { cls: '', label: () => t('settings.connections.added', 'Added') }
}

const reasonText = (reason) =>
  ({
    email: () => t('settings.connections.reason.email', 'Enter your full address, like you@gmail.com.'),
    notAdded: () => t('settings.connections.reason.notAdded', 'The agents do not have this server yet.'),
    otherServer: () => t('settings.connections.reason.otherServer', 'A different server already uses this name. Remove it under MCP servers, then try again.'),
    projectScope: () => t('settings.connections.reason.projectScope', "This server comes from the project's own settings, which Tessel does not start from here."),
    noAnswer: () => t('settings.connections.reason.noAnswer', 'The server did not answer. Check that it starts under MCP servers, then try again.'),
    noPage: () => t('settings.connections.reason.noPage', 'The server gave no sign-in page. Try again.')
  }[reason] || (() => t('settings.connections.reason.other', 'Could not start the sign-in. Try again.')))()

const SESSION_END = {
  failed: () => t('settings.connections.end.failed', 'The server stopped during the sign-in. Try again.'),
  expired: () => t('settings.connections.end.expired', 'The sign-in took too long. Try again.'),
  unknown: () => t('settings.connections.end.expired', 'The sign-in took too long. Try again.')
}

function stopPolling(id) {
  clearTimeout(timers.get(id))
  timers.delete(id)
}

function markConnected(entry, account) {
  const row = rows[entry.id]
  row.signedIn = true
  row.account = account || null
  if (account) row.email = account
  m.say(t('settings.connections.done', '{{name}} is connected. Restart running agent panes to load it.', { name: entry.name }))
}

function pollSession(entry) {
  const row = rows[entry.id]
  stopPolling(entry.id)
  if (leftPage) return
  timers.set(
    entry.id,
    setTimeout(async () => {
      const session = row.session
      if (!session) return
      let res
      try {
        res = await window.shellApi.mcpSignInStatus(session.id)
      } catch {
        res = { state: 'unknown' }
      }
      if (leftPage || row.session !== session) return
      if (res.state === 'waiting') return pollSession(entry)
      row.session = null
      if (res.state === 'done') markConnected(entry, res.account)
      else if (SESSION_END[res.state]) row.error = SESSION_END[res.state]()
    }, POLL_MS)
  )
}

async function signInLocal(entry) {
  const row = rows[entry.id]
  const agent = has(entry)[0]
  const res = await window.shellApi.mcpSignInStart({ agent, name: entry.id, scope: serverOf(entry, agent).scope, cwd: props.cwd, email: row.email })
  if (!res || !res.ok) {
    row.error = reasonText(res && res.reason)
    return
  }
  if (res.alreadySignedIn) {
    markConnected(entry, row.account)
    return
  }
  row.session = { id: res.id, page: res.page, code: res.code }
  pollSession(entry)
}

async function cancelSession(entry) {
  const row = rows[entry.id]
  const session = row.session
  row.session = null
  stopPolling(entry.id)
  if (session) await window.shellApi.mcpSignInCancel(session.id)
}

// Add to the agents that lack it: from an agent that has this very server
// (secrets stay in the main process), else from what was typed here.
async function addEverywhere(entry) {
  const row = rows[entry.id]
  const to = missing(entry)
  if (!to.length) return true
  const from = has(entry)[0]
  let out
  if (from) {
    out = {}
    for (const agent of to) {
      const res = await window.shellApi.mcpCopy({ from, to: agent, name: entry.id, scope: serverOf(entry, from).scope, cwd: props.cwd })
      out[agent] = res && res.ok ? { state: 'added' } : { state: 'failed', error: (res && res.error) || t('mcp.addFailed', 'failed') }
    }
  } else {
    out = await m.addToAgents(to, (agent) => ({ ...catalogSpec(entry, row.answers, agent), scope: 'user', cwd: props.cwd }))
  }
  await m.refresh()
  const failed = m.failuresText(out)
  if (failed) row.error = failed
  const present = has(entry).length > 0
  if (!present && !failed) row.error = t('settings.connections.notListed', 'The agents do not list it after adding it. See MCP servers.')
  return present
}

async function connect(entry) {
  const row = rows[entry.id]
  row.error = ''
  if (isLocal(entry) && !window.shellApi.mcpSignInStart) {
    row.error = t('settings.connections.needsRestart', 'Restart Tessel to finish installing this page, then try again.')
    return
  }
  if (conflicts(entry).length) {
    row.error = reasonText('otherServer')
    return
  }
  const lacking = askInputs(entry).find((i) => !String(row.answers[i.key] || '').trim())
  if (lacking) {
    row.error = enterLabel(lacking)
    return
  }
  // Before anything is written to an agent's settings.
  if (entry.signInEmail && !EMAIL_RE.test(row.email.trim())) {
    row.error = reasonText('email')
    return
  }
  if (!m.writable.length) {
    row.error = t('settings.connections.noAgent', 'No agent can receive it: install one under Agents.')
    return
  }
  row.busy = true
  const fromAccount = usesAccount(entry) && !has(entry).length
  try {
    if (fromAccount && !(await fillFromAccount(entry))) return
    const present = await addEverywhere(entry)
    if (present && isLocal(entry)) await signInLocal(entry)
  } catch (err) {
    row.error = (err && err.message) || reasonText()
  } finally {
    if (fromAccount) for (const key of Object.keys(row.answers)) row.answers[key] = ''
    row.busy = false
  }
}

async function fillFromAccount(entry) {
  const row = rows[entry.id]
  const client = await window.shellApi.tesselAccount.googleClient()
  if (client && client.clientId) {
    row.answers.GOOGLE_OAUTH_CLIENT_ID = client.clientId
    row.answers.GOOGLE_OAUTH_CLIENT_SECRET = client.clientSecret
    return true
  }
  if (client && client.error === 'signedOut') account.signedIn = false
  row.error =
    client && client.error === 'offline'
      ? t('settings.connections.accountOffline', 'Tessel could not reach its server. Check your connection and try again.')
      : client && client.error === 'signedOut'
        ? t('settings.connections.accountSignedOut', 'Your Tessel session ended. Sign in again, or use your own Google client.')
        : t('settings.connections.accountFailed', "Tessel's Google app is not available right now. Try again, or use your own Google client.")
  return false
}

async function loadAccount() {
  const res = await window.shellApi.tesselAccount?.status?.().catch(() => null)
  if (leftPage || !res || !res.signedIn) return
  account.signedIn = true
  const row = rows[ACCOUNT_SERVICE]
  if (row && !row.email && res.user && res.user.email) row.email = res.user.email
}

async function checkLocal(entry) {
  const row = rows[entry.id]
  const agent = has(entry)[0]
  if (!agent || !window.shellApi.mcpSignInState) return
  row.checking = true
  try {
    const res = await window.shellApi.mcpSignInState({ agent, name: entry.id, scope: serverOf(entry, agent).scope, cwd: props.cwd })
    if (leftPage || row.session) return
    row.signedIn = res ? res.signedIn : null
    row.account = (res && res.account) || null
    if (row.account && !row.email) row.email = row.account
  } catch {
    row.signedIn = null
  } finally {
    row.checking = false
  }
}

function toggle(entry) {
  const row = rows[entry.id]
  row.open = !row.open
}

async function copyCode(entry) {
  const row = rows[entry.id]
  if (row.session && (await copyText(row.session.code))) {
    row.copied = true
    setTimeout(() => (row.copied = false), 1500)
  }
}

// Sign-ins go to the user's own browser: never one agents can read.
function openPage(entry) {
  const session = rows[entry.id].session
  if (session) window.shellApi.openExternal(session.page)
}

// A sign-in that went on while the page was closed.
async function resumeSessions() {
  if (!window.shellApi.mcpSignInActive) return
  const active = (await window.shellApi.mcpSignInActive().catch(() => [])) || []
  if (leftPage) return
  for (const s of active) {
    const entry = entries.find((e) => e.id === s.name)
    if (!entry) continue
    rows[entry.id].session = { id: s.id, page: s.page, code: s.code }
    rows[entry.id].open = true
    pollSession(entry)
  }
}

const signedInLabel = (account) => t('settings.connections.account', 'Signed in as {{account}}.', { account })
const enterLabel = (input) => t('settings.connections.enter', 'Enter {{field}}.', { field: input.label })
const needsToolLabel = (entry) =>
  t('mcp.catalog.needsTool', "This server needs {{tool}}, which isn't installed.", { tool: entry.requires === 'uvx' ? 'uv' : 'Node.js' })
const connectLabel = (entry) =>
  status(entry) === 'connected' ? t('settings.connections.reconnect', 'Connect again') : t('settings.connections.connect', 'Connect')
// A hosted service is done once every agent has it; its sign-ins are per agent.
const showConnect = (entry) => isLocal(entry) || !has(entry).length || missing(entry).length > 0

onMounted(async () => {
  await Promise.all([m.refresh(), m.checkTools(), loadAccount()])
  if (leftPage) return
  await resumeSessions()
  await Promise.all(entries.filter((e) => isLocal(e) && has(e).length && !rows[e.id].session).map(checkLocal))
})
onBeforeUnmount(() => {
  // The sign-in goes on without the page, which finds it again when it comes back.
  leftPage = true
  for (const id of [...timers.keys()]) stopPolling(id)
})
</script>

<template>
  <div class="conn">
    <TesselConnections @open-account="emit('open-account')" />
    <p v-if="m.message.text" :class="m.message.kind === 'error' ? 'mcp-error' : 'mcp-notice'" role="status">{{ m.message.text }}</p>
    <ul class="sl-list" :aria-label="t('settings.connections.list', 'Services')">
      <SettingsListItem
        v-for="entry in entries"
        :key="entry.id"
        :open="rows[entry.id].open"
        :name="entry.name"
        :desc="rows[entry.id].open ? '' : entry.desc"
        :data-service="entry.id"
        @toggle="toggle(entry)"
      >
        <template #icon><BrandIcon :kind="'mcp-' + entry.id" :accent="entry.accent" :label="entry.name" :size="20" /></template>
        <template #tags>
          <span v-if="status(entry)" class="tag conn-status" :class="STATUS[status(entry)].cls">{{ STATUS[status(entry)].label() }}</span>
        </template>

        <div class="conn-details">
          <p class="conn-desc">{{ entry.desc }}</p>
          <p v-if="rows[entry.id].account && rows[entry.id].signedIn" class="set-hint conn-account">
            {{ signedInLabel(rows[entry.id].account) }}
          </p>

          <div v-if="entry.requires && m.haveCmd[entry.requires] === false" class="set-callout warn">
            <span class="set-callout-text">{{ needsToolLabel(entry) }}</span>
            <button type="button" class="exit-btn small" @click="emit('open-mcp')">{{ t('settings.connections.openMcp', 'Open MCP servers') }}</button>
          </div>

          <template v-if="entry.id === ACCOUNT_SERVICE && !has(entry).length">
            <p v-if="usesAccount(entry)" class="set-hint conn-from-account">
              {{ t('settings.connections.fromAccount', "Nothing to set up: your Tessel account uses Tessel's Google app. Google warns that the app is not verified yet: choose Advanced, then continue.") }}
              <button type="button" class="sl-link conn-own-client" @click="rows[entry.id].ownClient = true">{{ t('settings.connections.ownClient', 'Use my own Google client') }}</button>
            </p>
            <p v-else-if="!account.signedIn" class="set-hint conn-offer-account">
              {{ t('settings.connections.offerAccount', 'With a Tessel account there is nothing to set up. Otherwise, use your own Google client below.') }}
              <button type="button" class="sl-link conn-to-account" @click="emit('open-account')">{{ t('settings.connections.toAccount', 'Go to Tessel account') }}</button>
            </p>
            <p v-else class="set-hint">
              <button type="button" class="sl-link conn-back-to-account" @click="rows[entry.id].ownClient = false">{{ t('settings.connections.useAccount', "Use Tessel's Google app instead") }}</button>
            </p>
          </template>

          <div v-for="input in askInputs(entry)" :key="input.key" class="mcpc-field conn-field">
            <label :for="'conn-' + entry.id + '-' + input.key">{{ input.label }}</label>
            <input
              :id="'conn-' + entry.id + '-' + input.key"
              v-model="rows[entry.id].answers[input.key]"
              class="set-number conn-input"
              :type="input.kind === 'secret' ? 'password' : 'text'"
              spellcheck="false"
              autocomplete="off"
            />
            <span v-if="input.help" class="set-hint">{{ input.help }}</span>
          </div>
          <div v-if="entry.signInEmail" class="mcpc-field conn-field">
            <label :for="'conn-' + entry.id + '-email'">{{ t('settings.connections.email', 'Your Google address') }}</label>
            <input
              :id="'conn-' + entry.id + '-email'"
              v-model="rows[entry.id].email"
              class="set-number conn-input"
              type="email"
              spellcheck="false"
              autocomplete="off"
            />
          </div>

          <div v-if="rows[entry.id].session" class="set-callout conn-session" role="status">
            <span class="set-callout-text">
              <template v-if="rows[entry.id].session.code">
                {{ t('settings.connections.enterCode', 'Open the page, enter this code and sign in. This page updates by itself.') }}
                <strong class="conn-code">{{ rows[entry.id].session.code }}</strong>
              </template>
              <template v-else>{{ t('settings.connections.pageOpened', 'A sign-in page opened in your browser. Accept it there; this page updates by itself.') }}</template>
            </span>
            <span class="conn-session-actions">
              <button v-if="rows[entry.id].session.code" type="button" class="exit-btn small" @click="copyCode(entry)">
                <Check v-if="rows[entry.id].copied" :size="12" aria-hidden="true" />
                <Copy v-else :size="12" aria-hidden="true" />
                {{ t('settings.connections.copyCode', 'Copy the code') }}
              </button>
              <button type="button" class="exit-btn small conn-open-page" @click="openPage(entry)">
                {{ t('settings.connections.openPage', 'Open the page') }}<ExternalLink :size="11" aria-hidden="true" />
              </button>
              <button type="button" class="exit-btn small conn-cancel" @click="cancelSession(entry)">{{ t('settings.connections.cancel', 'Cancel') }}</button>
            </span>
          </div>

          <template v-if="!isLocal(entry) && has(entry).length">
            <p class="set-hint conn-hosted-hint">
              {{ t('settings.connections.hostedHint', 'Each agent signs in on its own, once. Tessel cannot see from here whether an agent has done it.') }}
            </p>
            <ul class="sl-subs">
              <li v-for="agent in has(entry)" :key="agent" class="sl-sub" :data-agent="agent">
                <div class="sl-sub-line">
                  <BrandIcon :kind="agent" :size="14" />
                  <span>{{ AGENT_NAME[agent] }}</span>
                  <span class="sl-actions">
                    <button type="button" class="exit-btn small" @click="m.signIn(agent, entry.id)">{{ t('mcp.installed.signIn', 'Sign in') }}</button>
                  </span>
                </div>
              </li>
            </ul>
          </template>

          <p v-if="rows[entry.id].error" class="mcpc-invalid conn-error" role="alert">{{ rows[entry.id].error }}</p>

          <div class="conn-actions">
            <button
              v-if="showConnect(entry)"
              type="button"
              class="exit-btn primary small conn-connect"
              :disabled="rows[entry.id].busy || rows[entry.id].checking || !!rows[entry.id].session || !m.loaded"
              @click="connect(entry)"
            >
              {{ rows[entry.id].busy ? t('settings.connections.connecting', 'Connecting…') : connectLabel(entry) }}
            </button>
            <button v-if="catalogDocs(entry)" type="button" class="sl-link conn-docs" @click="openLink(catalogDocs(entry), $event)">
              {{ t('mcp.catalog.docs', 'Documentation') }}<ExternalLink :size="11" aria-hidden="true" />
            </button>
          </div>
        </div>
      </SettingsListItem>
    </ul>
  </div>
</template>

<style scoped>
.conn-details {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 4px 8px 10px 0;
}
.conn-desc {
  margin: 0;
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.5;
}
.conn-status {
  flex: 0 0 auto;
}
.conn-account,
.conn-error,
.conn-hosted-hint {
  margin: 0;
}
.conn-field {
  max-width: 460px;
}
.conn-input {
  width: 100%;
  height: 28px;
  text-align: left;
}
.conn-session {
  flex-wrap: wrap;
}
.conn-code {
  margin-left: 6px;
  color: var(--text-strong);
  font-family: 'Cascadia Mono', Consolas, monospace;
  letter-spacing: 0.06em;
  user-select: text;
}
.conn-session-actions {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 6px;
}
.conn-session-actions .exit-btn,
.conn-docs {
  display: inline-flex;
  align-items: center;
  gap: 4px;
}
.conn-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 12px;
}
</style>
