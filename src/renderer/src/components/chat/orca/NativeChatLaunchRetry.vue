<script setup>
// After Orca's NativeChatLaunchRetry.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The chat could not start, or its process stopped: what happened and a
// way to start again, in the reference's one-line banner. The reference's
// launch lifecycle ('failed' | 'visibility-unknown') and Tessel's stopped
// states (ChatPane's "Start again"): not signed in (how to sign in, per
// agent), an untrusted folder ("Trust this folder…" asks through the pane's
// callback: ctx.chatOpen), the agent stopped or crashed (its error).
// Props: lifecycle, failureReason (the reference); status ('signin' |
//   'untrusted' | 'crashed' | 'ended'), agentId, error, opening (a start is
//   on its way: the button waits).
// Emits: retry (Retry / Start again / Trust this folder).
import { computed } from 'vue'
import { FolderLock, LogIn, RotateCcw, TriangleAlert } from 'lucide-vue-next'
import { Button } from './ui/index.js'
import { t } from '../../../i18n'

const props = defineProps({
  lifecycle: { type: String, default: null },
  failureReason: { type: String, default: null },
  status: { type: String, default: null },
  agentId: { type: String, default: null },
  error: { type: String, default: '' },
  opening: { type: Boolean, default: false }
})
const emit = defineEmits(['retry'])

const STOPPED = new Set(['signin', 'untrusted', 'crashed', 'ended'])
const tessel = computed(() => STOPPED.has(props.status))
const launch = computed(() => !tessel.value && (props.lifecycle === 'failed' || props.lifecycle === 'visibility-unknown'))

const launchMessage = computed(() =>
  props.lifecycle === 'failed'
    ? t('chat.orca.launchRetry.failed', 'Chat could not be started.')
    : t('chat.orca.launchRetry.unknown', 'Chat connection could not be confirmed.')
)
// How to sign in again: in a terminal pane of that agent.
const signinText = computed(() =>
  props.agentId === 'codex'
    ? t('chat.state.signinCodex', 'Codex is not signed in. Open a Codex terminal pane and sign in (codex login), then start again.')
    : props.agentId === 'opencode'
      ? t('chat.state.signinOpencode', 'OpenCode has no provider signed in. Open an OpenCode terminal pane and run opencode auth login, then start again.')
      : t('chat.state.signin', 'Claude is not signed in. Open a Claude terminal pane and run /login, then start again.')
)
</script>

<template>
  <div v-if="launch" class="nc-launch nc-launch--error" data-test="chat-launch-retry">
    <span class="nc-launch-text">{{ launchMessage }}{{ lifecycle === 'failed' && failureReason ? ` ${failureReason}` : '' }}</span>
    <Button type="button" variant="ghost" size="xs" @click="emit('retry')">
      <RotateCcw class="nc-size-3" aria-hidden="true" />
      {{ t('chat.orca.launchRetry.retry', 'Retry') }}
    </Button>
  </div>
  <div v-else-if="tessel" class="nc-launch" :class="['st-' + status, { 'nc-launch--error': status === 'crashed' || status === 'ended' }]" data-test="chat-state">
    <template v-if="status === 'signin'">
      <span class="nc-launch-text">
        <LogIn class="nc-launch-icon" aria-hidden="true" />
        {{ signinText }}
      </span>
      <Button type="button" variant="ghost" size="xs" data-test="chat-start-again" :disabled="opening" @click="emit('retry')">
        <RotateCcw class="nc-size-3" aria-hidden="true" />
        {{ t('chat.state.startAgain', 'Start again') }}
      </Button>
    </template>
    <template v-else-if="status === 'untrusted'">
      <span class="nc-launch-text">
        <FolderLock class="nc-launch-icon" aria-hidden="true" />
        {{ t('chat.state.untrusted', 'This folder is not trusted yet.') }}
      </span>
      <Button type="button" variant="ghost" size="xs" data-test="chat-trust" :disabled="opening" @click="emit('retry')">
        {{ t('chat.state.trust', 'Trust this folder…') }}
      </Button>
    </template>
    <template v-else>
      <span class="nc-launch-text">
        <TriangleAlert class="nc-launch-icon" aria-hidden="true" />
        <span>{{ t('chat.state.stopped', 'The agent stopped') }}</span>
        <span v-if="error" class="nc-launch-error" data-test="chat-state-error">{{ error }}</span>
      </span>
      <Button type="button" variant="ghost" size="xs" data-test="chat-start-again" :disabled="opening" @click="emit('retry')">
        <RotateCcw class="nc-size-3" aria-hidden="true" />
        {{ t('chat.state.startAgain', 'Start again') }}
      </Button>
    </template>
  </div>
</template>

<style scoped>
/* mx-auto flex w-full max-w-4xl items-center justify-between gap-3 px-4 py-1 text-xs text-destructive */
.nc-launch {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  width: 100%;
  max-width: 56rem;
  margin: 0 auto;
  padding: 4px 16px;
  color: var(--nc-muted-foreground);
  font-size: 12px;
  line-height: 16px;
}
.nc-launch--error {
  color: var(--nc-destructive);
}
/* min-w-0 break-words */
.nc-launch-text {
  display: inline-flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  min-width: 0;
  overflow-wrap: break-word;
}
.nc-launch-icon {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
}
.nc-launch-error {
  font-family: ui-monospace, 'Cascadia Mono', Consolas, monospace;
  overflow-wrap: anywhere;
  white-space: pre-wrap;
}
.nc-size-3 {
  width: 12px;
  height: 12px;
}
</style>
