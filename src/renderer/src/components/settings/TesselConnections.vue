<script setup>
// Settings > Connections, on top: Tessel's own connectors (tessel_apps). Connecting happens on
// tesselcode.com and the service's page; the tokens stay encrypted on this computer, agents
// never get them, and each agent is asked for before it first uses a service.
import { computed, onBeforeUnmount, onMounted, ref } from 'vue'
import { t } from '../../i18n'

const emit = defineEmits(['open-account'])
const SERVICES = [{ id: 'google', name: 'Gmail, Google Calendar, Google Drive' }] // i18n-ignore

const api = () => window.shellApi.tesselApps
const view = ref({ connections: [], connecting: null, error: null })
const signedOut = computed(() => view.value.error === 'signedOut')
const errorText = computed(() => {
  const e = view.value.error
  if (!e || e === 'signedOut') return ''
  if (e === 'denied') return t('settings.tesselApps.denied', 'Nothing was connected: access was refused on the service\'s page.')
  if (e === 'timedOut') return t('settings.tesselApps.timedOut', 'That took too long, so nothing was connected. Try again.')
  if (e === 'offline') return t('settings.tesselApps.offline', 'Could not reach tesselcode.com. Check the connection and try again.')
  if (e === 'unavailable') return t('settings.tesselApps.unavailable', 'This service cannot be connected yet.')
  if (e === 'noSecureStorage') return t('settings.tesselApps.noSecureStorage', 'This computer cannot keep the connection safely, so nothing was kept.')
  if (e === 'notRevoked') return t('settings.tesselApps.notRevoked', 'Disconnected here, but the service could not be told. To end its access too, remove Tessel Agents from your Google Account permissions: https://myaccount.google.com/permissions')
  if (e === 'noBrowser') return t('settings.tesselApps.noBrowser', 'The browser could not be opened.')
  return t('settings.tesselApps.failed', 'Something went wrong, so nothing was connected. Try again.')
})
const accountsOf = (service) => view.value.connections.filter((c) => c.service === service)

async function refresh() {
  const next = await api()?.view()
  if (next) view.value = next
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
    <div v-for="s in SERVICES" :key="s.id" class="tcx-row" :data-connector="s.id">
      <strong class="tcx-name">{{ s.name }}</strong>
      <ul v-if="accountsOf(s.id).length" class="tcx-accounts">
        <li v-for="c in accountsOf(s.id)" :key="c.account" data-test="tcx-account">
          <span class="tcx-account">{{ c.account }}</span>
          <span v-if="c.reconnect" class="tag warn" data-test="tcx-reconnect">{{ t('settings.tesselApps.reconnect', 'Connect it again') }}</span>
          <button type="button" class="mcp-btn" data-test="tcx-disconnect" @click="disconnect(s.id, c.account)">{{ t('settings.tesselApps.disconnect', 'Disconnect') }}</button>
        </li>
      </ul>
      <p v-if="view.connecting === s.id" class="set-hint" data-test="tcx-waiting">
        {{ t('settings.tesselApps.waiting', 'Waiting for your browser...') }}
        <button type="button" class="mcp-btn" @click="cancel">{{ t('settings.tesselApps.cancel', 'Cancel') }}</button>
      </p>
      <button v-else type="button" class="mcp-btn primary" data-test="tcx-connect" @click="connect(s.id)">
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
