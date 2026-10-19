<script setup>
// Live Share: what the share is doing, on top of the Share tab while it runs
// or gets ready. Sharing: a red dot, how many projects and since when (when
// main says), and the facts that hold for it: it comes back after a restart
// until you stop it, whether the ntfy.sh relay helps guests find it again,
// whether ignored and secret files are hidden, and that it came back by
// itself (for a couple of minutes after). Getting ready: how far it got, and
// Cancel (Stop sharing for a share starting again by itself). Stop sharing
// is here, the dialog asks first (stop).
import { computed } from 'vue'
import { Loader2 } from 'lucide-vue-next'
import { agoText, clockText } from '../../liveShareTime'
import { t } from '../../i18n'

const props = defineProps({
  host: { type: Object, required: true },
  // The projects shared (their count is in the title).
  projects: { type: Number, default: 0 },
  // Getting ready: what it does now (LiveShareDialog's progress line).
  progress: { type: String, default: '' },
  // The stop confirm is open: its own Stop sharing is the only one.
  confirming: { type: Boolean, default: false },
  // The time now (the dialog's clock), for "published 2 min ago".
  now: { type: Number, default: 0 }
})
// stop: Stop sharing (asked first by the dialog); cancel: while getting ready.
const emit = defineEmits(['stop', 'cancel'])

const sharing = computed(() => props.host.state === 'sharing')
const settings = computed(() => props.host.settings || {})
const relayOn = computed(() => settings.value.rendezvous !== false)
const hidden = computed(() => settings.value.hideIgnored !== false)
// Since when (main's start time, when it gives one), in the interface's language.
const sinceAt = computed(() => clockText(props.host.since || props.host.startedAt))
// When the relay last had the share's address (its tag's tooltip).
const relayTitle = computed(() => {
  if (!relayOn.value) return t('liveShare.status.relayOffHint', 'Guests can’t find your share again if its address changes.')
  const ago = agoText(props.host.relayAt, props.now || Date.now())
  return ago ? t('liveShare.setting.relayPublished', 'Your address was last published {{ago}}.', { ago }) : t('liveShare.setting.relayNotYet', 'Your address is not published yet.')
})
const title = computed(() => {
  const n = props.projects
  if (sinceAt.value)
    return n === 1 ? t('liveShare.status.sharingSince', 'Sharing {{count}} project since {{time}}', { count: 1, time: sinceAt.value }) : t('liveShare.status.sharingSince', 'Sharing {{count}} projects since {{time}}', { count: n, time: sinceAt.value })
  return n === 1 ? t('liveShare.status.sharing', 'Sharing {{count}} project', { count: 1 }) : t('liveShare.status.sharing', 'Sharing {{count}} projects', { count: n })
})
</script>

<template>
  <div class="lss" :class="{ live: sharing }" role="status" data-test="ls-status">
    <template v-if="sharing">
      <span class="lss-dot" aria-hidden="true"></span>
      <div class="lss-main">
        <div class="lss-title" data-test="ls-status-title">{{ title }}</div>
        <div class="lss-tags">
          <span class="tag tag-scope" :title="t('liveShare.status.permanentHint', 'Until you stop it, the share starts again by itself when Tessel restarts, with its invitations and people.')" data-test="ls-status-permanent">{{ t('liveShare.status.permanent', 'Comes back after restarts') }}</span>
          <span class="tag" :class="relayOn ? 'tag-ok' : 'tag-off'" :title="relayTitle" data-test="ls-status-relay">{{ relayOn ? t('liveShare.status.relayOn', 'Relay on') : t('liveShare.status.relayOff', 'Relay off') }}</span>
          <span v-if="hidden" class="tag" data-test="ls-status-hidden">{{ t('liveShare.status.hidden', 'Secret files hidden') }}</span>
          <span v-if="host.resumed" class="tag tag-info" data-test="ls-status-resumed">{{ t('liveShare.status.resumed', 'Came back after a restart') }}</span>
        </div>
      </div>
      <button v-if="!confirming" type="button" class="confirm-btn ls-small primary danger lss-btn" data-test="ls-stop" @click="emit('stop')">{{ t('liveShare.share.stop', 'Stop sharing') }}</button>
    </template>
    <template v-else>
      <Loader2 :size="15" class="bp-spin lss-spin" aria-hidden="true" />
      <div class="lss-main">
        <div class="lss-progress" data-test="ls-progress">{{ progress }}</div>
      </div>
      <button type="button" class="confirm-btn ls-small lss-btn" data-test="ls-cancel-share" @click="emit('cancel')">{{ host.restarting ? t('liveShare.share.stop', 'Stop sharing') : t('liveShare.share.cancel', 'Cancel') }}</button>
    </template>
  </div>
</template>

<style scoped>
.lss {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-bottom: 12px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 10px;
  background: var(--surface-2);
}
.lss.live {
  border-color: color-mix(in srgb, var(--danger) 35%, var(--border));
}
.lss-dot {
  flex: none;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--danger);
  box-shadow: 0 0 0 3px color-mix(in srgb, var(--danger) 25%, transparent);
}
.lss-spin {
  flex: none;
  color: var(--text-dim);
}
.lss-main {
  display: flex;
  flex: 1;
  flex-direction: column;
  gap: 4px;
  min-width: 0;
}
.lss-title {
  color: var(--text-strong);
  font-size: 13px;
  font-weight: 600;
  overflow-wrap: anywhere;
}
.lss-progress {
  color: var(--text);
  font-size: 12.5px;
  line-height: 1.45;
  overflow-wrap: anywhere;
}
.lss-tags {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.lss-btn {
  flex: none;
}
</style>
