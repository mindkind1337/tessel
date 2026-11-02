<script setup>
// Settings > Connections, on top: Tessel's own connectors (tessel_apps). Connecting happens on
// tesselcode.com and the service's page; the tokens stay encrypted on this computer, agents
// never get them, and each agent is asked for before it first uses a service. The server says
// which services can be connected now: the others say so, rather than failing after a click.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../../i18n'

const emit = defineEmits(['open-account'])
// name: what the person sees, which is a service's own name. short: the same, in a sentence.
const SERVICES = [
  { id: 'google', name: 'Gmail, Google Calendar, Google Drive', short: 'Google' }, // i18n-ignore
  { id: 'microsoft', name: 'Outlook mail, Outlook Calendar, OneDrive', short: 'Microsoft' }, // i18n-ignore
  { id: 'github', name: 'GitHub', short: 'GitHub' }, // i18n-ignore
  { id: 'dropbox', name: 'Dropbox', short: 'Dropbox' }, // i18n-ignore
  { id: 'notion', name: 'Notion', short: 'Notion' }, // i18n-ignore
  { id: 'linear', name: 'Linear', short: 'Linear' }, // i18n-ignore
  { id: 'atlassian', name: 'Jira, Confluence', short: 'Atlassian' }, // i18n-ignore
  { id: 'sentry', name: 'Sentry', short: 'Sentry' }, // i18n-ignore
  { id: 'vercel', name: 'Vercel', short: 'Vercel' }, // i18n-ignore
  { id: 'stripe', name: 'Stripe', short: 'Stripe' } // i18n-ignore
]
// Where a person ends a service's access themselves.
const whereToEnd = (id) => {
  if (id === 'google') return t('settings.tesselApps.whereGoogle', 'remove Tessel Agents from your Google Account permissions: https://myaccount.google.com/permissions')
  if (id === 'microsoft') return t('settings.tesselApps.whereMicrosoft', 'remove Tessel from your Microsoft account: https://account.live.com/consent/Manage (personal account) or https://myapplications.microsoft.com (work or school account)')
  if (id === 'github') return t('settings.tesselApps.whereGithub', 'remove Tessel from your GitHub authorizations: https://github.com/settings/apps/authorizations')
  if (id === 'dropbox') return t('settings.tesselApps.whereDropbox', 'remove Tessel from your Dropbox connected apps: https://www.dropbox.com/account/connected_apps')
  if (id === 'notion') return t('settings.tesselApps.whereNotion', 'remove Tessel in Notion: Settings > Connections')
  if (id === 'linear') return t('settings.tesselApps.whereLinear', 'remove Tessel in Linear: Settings > Account > Security & access')
  if (id === 'atlassian') return t('settings.tesselApps.whereAtlassian', 'remove Tessel from your Atlassian connected apps: https://id.atlassian.com/manage-profile/apps')
  if (id === 'sentry') return t('settings.tesselApps.whereSentry', 'remove Tessel in Sentry: Settings > Account > Authorized Applications')
  if (id === 'vercel') return t('settings.tesselApps.whereVercel', 'remove Tessel in your Vercel account settings')
  if (id === 'stripe') return t('settings.tesselApps.whereStripe', 'uninstall Tessel in the Stripe Dashboard: Settings > Installed apps')
  return ''
}

const api = () => window.shellApi.tesselApps
const view = ref({ connections: [], connecting: null, error: null, notEnded: [] })
// undefined: not known yet. null: the server could not be asked. A list: what it answered.
const ready = ref(undefined)
const signedOut = computed(() => view.value.error === 'signedOut')
const errorText = computed(() => {
  const e = view.value.error
  // notRevoked says which service, and how, in the lines below.
  if (!e || e === 'signedOut' || e === 'notRevoked') return ''
  if (e === 'denied') return t('settings.tesselApps.denied', 'Nothing was connected: access was refused on the service\'s page.')
  if (e === 'timedOut') return t('settings.tesselApps.timedOut', 'That took too long, so nothing was connected. Try again.')
  if (e === 'offline') return t('settings.tesselApps.offline', 'Could not reach tesselcode.com. Check the connection and try again.')
  if (e === 'unavailable') return t('settings.tesselApps.unavailable', 'This service cannot be connected yet.')
  if (e === 'noSecureStorage') return t('settings.tesselApps.noSecureStorage', 'This computer cannot keep the connection safely, so nothing was kept.')
  if (e === 'noBrowser') return t('settings.tesselApps.noBrowser', 'The browser could not be opened.')
  return t('settings.tesselApps.failed', 'Something went wrong, so nothing was connected. Try again.')
})
// After disconnecting: a service that still has its access, why, and where to end it.
const notEndedLines = computed(() =>
  (view.value.notEnded || []).map(({ service, how }) => {
    const found = SERVICES.find((s) => s.id === service)
    const params = { service: found ? found.short : service, where: whereToEnd(service) }
    return how === 'byHand'
      ? t('settings.tesselApps.byHand', 'Disconnected here: the token is gone from this computer. {{service}} gives apps no way to end an access. To end it now, {{where}}', params)
      : t('settings.tesselApps.notRevoked', 'Disconnected here, but {{service}} could not be told. To end its access too, {{where}}', params)
  })
)
const accountsOf = (service) => view.value.connections.filter((c) => c.service === service)
const canConnect = (service) => ready.value !== undefined && (ready.value === null || ready.value.includes(service))
const notYet = (service) => Array.isArray(ready.value) && !ready.value.includes(service)

async function refresh() {
  const next = await api()?.view()
  if (next) view.value = next
}
async function askWhatIsReady() {
  const answer = await api()?.services?.().catch(() => null)
  ready.value = Array.isArray(answer?.services) ? answer.services : null
}
async function connect(service) {
  const next = await api()?.connect(service)
  if (next) view.value = next
}
async function cancel() {
  const next = await api()?.cancel()
  if (next) view.value = next
}
async function disconnect(service, account) {
  const next = await api()?.disconnect({ service, account })
  if (next) view.value = next
}

let off = null
onMounted(() => {
  refresh()
  askWhatIsReady()
  off = api()?.onChanged?.((next) => {
    if (next) view.value = next
  })
})
onBeforeUnmount(() => off && off())
</script>

<template>
  <section class="tcx" data-test="tessel-connections">
    <h4 class="tcx-title">{{ t('settings.tesselApps.title', 'Tessel connectors') }}</h4>
    <p class="set-hint">{{ t('settings.tesselApps.hint', 'For every agent. You sign in on the service\'s own page, your tokens stay encrypted on this computer, and each agent asks you before it first uses a service.') }}</p>
    <p v-if="signedOut" class="set-callout warn" data-test="tcx-signed-out">
      {{ t('settings.tesselApps.signedOut', 'Connecting needs a Tessel account.') }}
      <button type="button" class="mcp-btn" @click="emit('open-account')">{{ t('settings.tesselApps.signIn', 'Sign in') }}</button>
    </p>
    <p v-else-if="errorText" class="mcp-error" role="status" data-test="tcx-error">{{ errorText }}</p>
    <p v-for="line in notEndedLines" :key="line" class="mcp-error" role="status" data-test="tcx-not-ended">{{ line }}</p>
    <div v-for="s in SERVICES" :key="s.id" class="tcx-row" :data-connector="s.id">
      <strong class="tcx-name">{{ s.name }}</strong>
      <span v-if="s.id === 'stripe'" class="set-hint">{{ t('settings.tesselApps.stripeNote', 'Read only.') }}</span>
      <ul v-if="accountsOf(s.id).length" class="tcx-accounts">
        <li v-for="c in accountsOf(s.id)" :key="c.account" data-test="tcx-account">
          <span class="tcx-account">{{ c.label || c.account }}</span>
          <span v-if="c.reconnect" class="tag warn" data-test="tcx-reconnect">{{ t('settings.tesselApps.reconnect', 'Connect it again') }}</span>
          <button type="button" class="mcp-btn" data-test="tcx-disconnect" @click="disconnect(s.id, c.account)">{{ t('settings.tesselApps.disconnect', 'Disconnect') }}</button>
        </li>
      </ul>
      <p v-if="view.connecting === s.id" class="set-hint" data-test="tcx-waiting">
        {{ t('settings.tesselApps.waiting', 'Waiting for your browser...') }}
        <button type="button" class="mcp-btn" @click="cancel">{{ t('settings.tesselApps.cancel', 'Cancel') }}</button>
      </p>
      <p v-else-if="notYet(s.id)" class="set-hint" data-test="tcx-not-yet">{{ t('settings.tesselApps.notYet', 'Not available yet: Tessel\'s app for this service is not registered.') }}</p>
      <button v-else-if="canConnect(s.id)" type="button" class="mcp-btn primary" data-test="tcx-connect" @click="connect(s.id)">
        {{ accountsOf(s.id).length ? t('settings.tesselApps.another', 'Connect another account') : t('settings.tesselApps.connect', 'Connect') }}
      </button>
    </div>
  </section>
</template>

<style scoped>
.tcx {
  display: grid;
  gap: 8px;
  margin-bottom: 16px;
}
.tcx-title {
  margin: 0;
}
/* The name with its button on one line, each account under it with its own: all at the right edge. */
.tcx-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto;
  gap: 8px 12px;
  align-items: center;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
}
.tcx-row > .mcp-btn {
  grid-column: 2;
  grid-row: 1;
  justify-self: end;
}
.tcx-row > .set-hint,
.tcx-accounts {
  grid-column: 1 / -1;
}
.tcx-accounts {
  display: grid;
  gap: 4px;
  margin: 0;
  padding: 0;
  list-style: none;
}
.tcx-accounts li {
  display: flex;
  align-items: center;
  gap: 8px;
}
.tcx-account {
  min-width: 0;
  overflow-wrap: anywhere;
}
.tcx-accounts li .mcp-btn {
  flex: none;
  margin-left: auto;
}
</style>
