<script setup>
// Live Share, on a guest's computer: the commands of the host's agent that were
// allowed here, while they run and after: what ran, what it printed (it went
// back to that agent), and a way to stop it (liveShareCommands.js).
import { t } from '../i18n'

defineProps({
  // [{ id, hostName, agent, command, state, exitCode, output }]
  runs: { type: Array, default: () => [] }
})
const emit = defineEmits(['stop', 'dismiss'])

const titleOf = (r) => t('liveShare.hostCommand.title', 'On your computer, for {{agent}} ({{host}})', { agent: r.agent, host: r.hostName })
function stateOf(r) {
  if (r.state === 'running') return t('liveShare.hostCommand.running', 'Running')
  if (r.state === 'stopped') return t('liveShare.hostCommand.stopped', 'Stopped')
  if (r.state === 'timeout') return t('liveShare.hostCommand.timeout', 'Stopped: it took too long')
  if (r.state === 'failed') return t('liveShare.hostCommand.failed', 'Could not run')
  return t('liveShare.hostCommand.done', 'Done, exit code {{code}}', { code: r.exitCode === null ? '?' : r.exitCode })
}
</script>

<template>
  <section class="hcp" data-test="host-commands" :aria-label="t('liveShare.hostCommand.list', 'Commands run on your computer')">
    <article v-for="r in runs" :key="r.id" class="hcp-card" data-test="host-command">
      <header class="hcp-head">
        <strong class="hcp-title">{{ titleOf(r) }}</strong>
        <span class="hcp-state" data-test="host-command-state">{{ stateOf(r) }}</span>
        <button v-if="r.state === 'running'" type="button" class="confirm-btn danger" data-test="host-command-stop" @click="emit('stop', r.id)">{{ t('liveShare.hostCommand.stop', 'Stop') }}</button>
        <button v-else type="button" class="confirm-btn" data-test="host-command-dismiss" @click="emit('dismiss', r.id)">{{ t('liveShare.hostCommand.dismiss', 'Close') }}</button>
      </header>
      <pre class="hcp-code">{{ r.command }}</pre>
      <template v-if="r.output">
        <p class="hcp-note">{{ t('liveShare.hostCommand.sent', 'What it printed, sent back to that agent:') }}</p>
        <pre class="hcp-code hcp-output" data-test="host-command-output">{{ r.output }}</pre>
      </template>
    </article>
  </section>
</template>

<style scoped>
.hcp {
  position: fixed;
  right: 16px;
  bottom: 16px;
  /* Under the cards (.help-backdrop): it never covers the buttons of what is being asked. */
  z-index: 500;
  display: grid;
  gap: 8px;
  width: min(480px, calc(100vw - 32px));
  max-height: calc(100vh - 96px);
  overflow-y: auto;
}
.hcp-card {
  display: grid;
  gap: 6px;
  padding: 10px 12px;
  border: 1px solid var(--border);
  border-radius: 8px;
  background: var(--surface-2);
  box-shadow: 0 8px 24px rgb(0 0 0 / 35%);
}
.hcp-head {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.hcp-title {
  flex: 1;
  min-width: 0;
  font-size: 12.5px;
  overflow-wrap: anywhere;
}
.hcp-state {
  flex: none;
  font-size: 11.5px;
  color: var(--text-dim);
}
.hcp-note {
  margin: 0;
  font-size: 11.5px;
  color: var(--text-dim);
}
.hcp-code {
  margin: 0;
  padding: 6px 8px;
  max-height: 96px;
  overflow: auto;
  border-radius: 5px;
  background: var(--term);
  font-size: 11.5px;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.hcp-output {
  max-height: 180px;
}
</style>
