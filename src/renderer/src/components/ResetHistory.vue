<!-- i18n-pending: text here does not go through t() yet -->
<script setup>
import { ref, watch, onBeforeUnmount } from 'vue'
const props = defineProps({
  provider: { type: String, default: undefined },
  accountId: { type: String, default: undefined },
  compact: Boolean,
  revision: { type: Number, default: 0 }
})
const expanded = ref(!props.compact),
  rows = ref([]),
  visible = ref(20),
  busy = ref(false),
  error = ref('')
const remote = ref(null),
  remoteBusy = ref(false),
  remoteError = ref('')
let sequence = 0,
  remoteSequence = 0,
  disposed = false
const outcomes = {
  reset: 'Limits reset',
  nothing_to_reset: 'Nothing to reset',
  no_credit: 'No credit',
  already_redeemed: 'Already redeemed',
  error: 'Failed',
  pending: 'Result unknown'
}
const date = (value) =>
  value
    ? new Date(value).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })
    : 'Not provided'
const count = (value) =>
  value === null || value === undefined ? 'Unknown' : value.toLocaleString()
async function load() {
  const id = ++sequence
  busy.value = true
  error.value = ''
  try {
    const result = await window.shellApi?.providerUsage?.resetHistory({
      ...(props.provider ? { provider: props.provider } : {}),
      ...(props.accountId !== undefined ? { accountId: props.accountId } : {})
    })
    if (disposed || id !== sequence) return
    if (!result?.ok) throw new Error(result?.error || 'Local reset history is unavailable.')
    rows.value = result.entries || []
  } catch (err) {
    if (!disposed && id === sequence) error.value = err.message || 'Could not read reset history.'
  } finally {
    if (!disposed && id === sequence) busy.value = false
  }
}
async function loadCredits() {
  const id = ++remoteSequence
  remoteBusy.value = true
  remoteError.value = ''
  remote.value = null
  try {
    let accountId = props.accountId
    let label = 'Selected Codex account'
    if (accountId === undefined) {
      const state = await window.shellApi.accounts.list()
      if (disposed || id !== remoteSequence) return
      const provider = state?.providers?.find((row) => row.provider === 'codex')
      if (!state?.ok || !provider || provider.error)
        throw new Error('Could not verify the selected Codex account.')
      accountId = provider.selectedId ?? null
      label =
        (accountId === null ? provider.system : provider.accounts?.find((a) => a.id === accountId))
          ?.label || label
    }
    const result = await window.shellApi.providerUsage.creditHistory({
      provider: 'codex',
      accountId
    })
    if (disposed || id !== remoteSequence) return
    if (!result?.ok) throw new Error(result?.error || 'Could not read Codex credits.')
    if (result.provider !== 'codex' || result.accountId !== accountId)
      throw new Error('The account changed. Refresh credits.')
    remote.value = { ...result, label }
  } catch (err) {
    if (!disposed && id === remoteSequence)
      remoteError.value = err.message || 'Could not read Codex credits.'
  } finally {
    if (!disposed && id === remoteSequence) remoteBusy.value = false
  }
}
watch(
  () => [props.provider, props.accountId, props.revision, expanded.value],
  () => {
    ++sequence
    ++remoteSequence
    rows.value = []
    remote.value = null
    remoteError.value = ''
    remoteBusy.value = false
    visible.value = 20
    if (expanded.value) load()
  },
  { immediate: true }
)
onBeforeUnmount(() => {
  disposed = true
  ++sequence
  ++remoteSequence
})
</script>

<template>
  <section class="reset-history" :class="{ compact }" data-test="reset-history">
    <div class="rh-heading">
      <button
        type="button"
        class="rh-title"
        :aria-expanded="expanded"
        @click="expanded = !expanded"
      >
        Reset history <span aria-hidden="true">{{ expanded ? '−' : '+' }}</span>
      </button>
      <button v-if="expanded" type="button" class="rh-button" :disabled="busy" @click="load">
        Refresh
      </button>
    </div>
    <div v-if="expanded">
      <p class="rh-muted">
        Resets requested in Tessel on this computer. Keeps the latest 500 attempts. Earlier resets
        are not reconstructed.
      </p>
      <p v-if="busy" role="status" class="rh-muted">Loading history…</p>
      <p v-if="error" class="rh-error" role="alert">{{ error }}</p>
      <p v-else-if="!busy && !rows.length" class="rh-muted">No resets recorded yet.</p>
      <ol v-if="rows.length" class="rh-list">
        <li v-for="row in rows.slice(0, visible)" :key="row.id" class="rh-row">
          <div class="rh-line">
            <strong :class="{ 'rh-error': row.uncertain || row.outcome === 'error' }">{{
              row.uncertain ? 'Result unknown' : outcomes[row.outcome] || 'Unknown'
            }}</strong
            ><time>{{ date(row.at) }}</time>
          </div>
          <div class="rh-muted">
            {{ row.provider === 'codex' ? 'Codex' : 'Claude' }} · {{ row.accountLabel }}
            <span v-if="row.accountId" :title="row.accountId">({{ row.accountId }})</span>
          </div>
          <div class="rh-muted">
            Credits: {{ count(row.creditsBefore) }} → {{ count(row.creditsAfter) }}
          </div>
          <p v-if="row.uncertain" class="rh-muted">
            Not confirmed. Check current usage before requesting another reset.
          </p>
          <p v-else-if="row.outcome === 'error'" class="rh-muted">
            {{
              row.code === 'history'
                ? 'History could not be saved; no reset was sent.'
                : 'The request failed before a reset was confirmed.'
            }}
          </p>
          <details v-if="row.windows?.length" class="rh-windows">
            <summary>Windows observed before request</summary>
            <div v-for="(win, i) in row.windows" :key="i">
              {{ win.label }} · {{ win.usedPct ?? 'Unknown' }}% used · reset
              {{ date(win.resetsAt) }}
            </div>
          </details>
        </li>
      </ol>
      <button v-if="rows.length > visible" type="button" class="rh-button" @click="visible += 20">
        Show more ({{ rows.length - visible }})
      </button>
      <div v-if="!provider || provider === 'codex'" class="rh-provider">
        <button
          type="button"
          class="rh-button"
          :disabled="remoteBusy"
          data-test="reset-provider-credits"
          @click="loadCredits"
        >
          {{ remoteBusy ? 'Reading Codex credits…' : 'Read Codex credit records' }}
        </button>
        <p class="rh-muted">
          Reads the selected account only on click. Provider credit statuses are separate from local
          reset attempts; grant and expiry dates are not reset dates.
        </p>
        <p v-if="remoteError" class="rh-error" role="alert">{{ remoteError }}</p>
        <template v-if="remote">
          <p class="rh-muted">{{ remote.label }} · {{ date(remote.observedAt) }}</p>
          <p v-if="!remote.available" class="rh-muted">
            The provider did not return individual credit records.
          </p>
          <p v-else-if="!remote.entries.length" class="rh-muted">
            No credit records returned by the provider.
          </p>
          <ul v-else class="rh-list rh-credits">
            <li v-for="(credit, i) in remote.entries" :key="i" class="rh-row">
              <strong>{{ credit.status }}</strong>
              <div class="rh-muted">
                Granted {{ date(credit.grantedAt) }} · Expires {{ date(credit.expiresAt) }}
              </div>
            </li>
          </ul>
          <p v-if="remote.truncated" class="rh-muted">Showing the first 500 provider records.</p>
        </template>
      </div>
    </div>
  </section>
</template>

<style scoped>
.reset-history {
  margin-top: 20px;
  padding-top: 16px;
  border-top: 1px solid var(--border);
  font-size: 12px;
  min-width: 0;
}
.reset-history.compact {
  margin-top: 12px;
  padding-top: 10px;
}
.rh-heading,
.rh-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex-wrap: wrap;
}
.rh-title {
  display: flex;
  align-items: center;
  gap: 10px;
  font: inherit;
  font-weight: 600;
  color: inherit;
  border: 0;
  background: none;
  padding: 3px 0;
  cursor: pointer;
}
.rh-button {
  font: inherit;
  color: inherit;
  border: 1px solid var(--border);
  background: transparent;
  border-radius: 5px;
  padding: 4px 8px;
  cursor: pointer;
}
.rh-button:disabled {
  opacity: 0.5;
  cursor: default;
}
.rh-muted,
time {
  color: var(--muted);
  font-size: 11px;
  line-height: 1.5;
  overflow-wrap: anywhere;
}
.rh-muted {
  margin: 5px 0;
}
.rh-error {
  color: var(--danger, #de877d);
}
.rh-list {
  list-style: none;
  margin: 8px 0;
  padding: 0;
}
.rh-row {
  padding: 9px 0;
  border-bottom: 1px solid var(--border);
  overflow-wrap: anywhere;
}
.rh-line strong {
  font-weight: 500;
}
.rh-windows {
  margin-top: 5px;
  color: var(--muted);
  font-size: 11px;
  line-height: 1.6;
}
.rh-windows summary {
  cursor: pointer;
}
.rh-provider {
  margin-top: 12px;
}
.rh-credits {
  max-height: 240px;
  overflow-y: auto;
}
</style>
