<script setup>
// One provider in Settings > AI provider accounts: icon, name and one status
// line, its main actions on the right, and its details (accounts, keys,
// options, usage) folded below. The details open by themselves only when
// something needs the person (`attention`: an expired sign-in, an error).
// They stay in the page while closed (v-show), so Settings search finds them.
import { ref, watch } from 'vue'
import BrandIcon from './BrandIcon.vue'
import { t } from '../i18n'

const props = defineProps({
  provider: { type: String, required: true }, // data-provider
  icon: { type: String, required: true }, // BrandIcon kind
  iconLabel: { type: String, default: '' },
  iconAccent: { type: String, default: '' },
  name: { type: String, required: true },
  status: { type: String, default: '' },
  // ok | warn | error | dim
  tone: { type: String, default: 'dim' },
  attention: { type: Boolean, default: false },
  // 'details' (Details) or 'configure' (Configure)
  toggle: { type: String, default: 'details' },
  hasDetails: { type: Boolean, default: true }
})
const open = ref(props.attention)
watch(
  () => props.attention,
  (now) => {
    if (now) open.value = true
  }
)
const detailsId = `provider-details-${props.provider}` // i18n-ignore
</script>

<template>
  <section
    class="account-provider prov-row"
    :class="{ open: open && hasDetails, attention }"
    :data-provider="provider"
    :aria-label="name"
  >
    <div class="prov-head">
      <BrandIcon :kind="icon" :label="iconLabel || undefined" :accent="iconAccent || undefined" :size="16" />
      <div class="prov-text">
        <span class="prov-name">{{ name }}</span>
        <span class="prov-status" :class="tone" data-test="provider-status" aria-live="polite">{{ status }}</span>
      </div>
      <div class="prov-actions">
        <slot name="actions" />
        <button
          v-if="hasDetails"
          type="button"
          class="exit-btn prov-toggle"
          :aria-expanded="open"
          :aria-controls="detailsId"
          data-test="provider-details-toggle"
          @click="open = !open"
        >
          {{ toggle === 'configure' ? t('settings.accounts.row.configure', 'Configure') : t('settings.accounts.row.details', 'Details') }}<span
            class="prov-caret"
            aria-hidden="true"
          ></span>
        </button>
      </div>
    </div>
    <div v-if="$slots.note" class="prov-note"><slot name="note" /></div>
    <slot name="live" />
    <div v-if="hasDetails" v-show="open" :id="detailsId" class="prov-details" data-test="provider-details">
      <slot />
    </div>
  </section>
</template>

<style scoped>
.prov-row {
  min-width: 0;
  padding: 12px 0;
  border-top: 1px solid var(--border);
  color: var(--text);
  font-size: 12.5px;
}
.prov-head {
  display: flex;
  align-items: center;
  gap: 12px;
  min-height: 34px;
  min-width: 0;
}
.prov-head > .brand-icon {
  flex: 0 0 auto;
}
.prov-text {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.prov-name {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 500;
}
.prov-status {
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.4;
  overflow-wrap: anywhere;
}
.prov-status.ok {
  color: var(--text);
}
.prov-status.warn {
  color: var(--warn);
}
.prov-status.error {
  color: var(--danger);
}
.prov-actions {
  flex: 0 0 auto;
  display: flex;
  align-items: center;
  gap: 6px;
}
.prov-toggle {
  display: inline-flex;
  align-items: center;
  gap: 6px;
}
.prov-caret {
  width: 6px;
  height: 6px;
  border-right: 1.5px solid currentColor;
  border-bottom: 1.5px solid currentColor;
  transform: translateY(-2px) rotate(45deg);
  transition: transform 0.15s;
}
.open .prov-caret {
  transform: translateY(1px) rotate(-135deg);
}
/* Notes and details line up under the name, not under the icon. */
.prov-note,
.prov-details {
  margin-left: 28px;
  min-width: 0;
}
.prov-note {
  margin-top: 6px;
  color: var(--text-dim);
  font-size: 11.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.attention .prov-note {
  color: var(--warn);
}
.prov-details {
  display: grid;
  gap: 12px;
  margin-top: 12px;
}
.prov-row :deep(code) {
  font-size: 11px;
}
@media (max-width: 560px) {
  .prov-head {
    flex-wrap: wrap;
  }
  .prov-actions {
    margin-left: 28px;
  }
}
</style>
