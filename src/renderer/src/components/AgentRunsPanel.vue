<script setup>
// What agents ran in a terminal (its "Agent commands (N)" badge): newest first,
// one card each: what kind (a command, keys, a read), which agent, when, and
// the command itself in a block that folds when it is long, with a copy button.
import { computed, reactive } from 'vue'
import { t, intlLocale } from '../i18n'

const props = defineProps({
  // [{ at, agent, kind: 'run' | 'keys' | 'read', text, yolo }], oldest first.
  runs: { type: Array, default: () => [] }
})
const emit = defineEmits(['copy'])

// A command longer than this many lines or characters starts folded.
const FOLD_LINES = 4
const FOLD_CHARS = 240
const open = reactive({})
const cards = computed(() =>
  props.runs
    .map((r, i) => {
      const text = String(r.text || '')
      return { ...r, key: `${r.at}-${i}`, text, long: text.split('\n').length > FOLD_LINES || text.length > FOLD_CHARS }
    })
    .reverse()
)

const kindLabel = (k) => (k === 'keys' ? t('pane.agentTerminal.kindKeys', 'Keys') : k === 'read' ? t('pane.agentTerminal.kindRead', 'Read') : t('pane.agentTerminal.kindCommand', 'Command'))
function time(at) {
  try {
    return new Date(at).toLocaleTimeString(intlLocale(), { hour: '2-digit', minute: '2-digit', second: '2-digit' })
  } catch {
    return ''
  }
}
</script>

<template>
  <div class="arp" data-test="pane-agent-terminal-list">
    <header class="arp-head">
      <strong>{{ t('pane.agentTerminal.logTitle', 'Run by agents in this terminal') }}</strong>
      <span class="arp-count" data-test="arp-count">{{ runs.length }}</span>
    </header>
    <p v-if="!cards.length" class="arp-empty">{{ t('pane.agentTerminal.noLog', 'Nothing run yet') }}</p>
    <ul v-else class="arp-list">
      <li v-for="c in cards" :key="c.key" class="arp-card" :class="'arp-' + (c.kind || 'run')" data-test="pane-agent-term-row">
        <div class="arp-top">
          <span class="arp-kind">{{ kindLabel(c.kind) }}</span>
          <span class="arp-agent">{{ c.agent }}</span>
          <span v-if="c.yolo" class="arp-yolo" :title="t('pane.agentTerminal.yoloHint', 'This agent runs in Yolo: its commands in its own terminal are not asked first.')">{{ t('pane.agentTerminal.yolo', 'Yolo, not asked') }}</span>
          <time class="arp-time">{{ time(c.at) }}</time>
        </div>
        <div v-if="c.text" class="arp-body">
          <pre class="arp-cmd" :class="{ folded: c.long && !open[c.key] }" data-test="arp-cmd">{{ c.text }}</pre>
          <div class="arp-actions">
            <button v-if="c.long" type="button" class="arp-btn" data-test="arp-fold" @click.stop="open[c.key] = !open[c.key]">
              {{ open[c.key] ? t('pane.agentTerminal.showLess', 'Show less') : t('pane.agentTerminal.showMore', 'Show all') }}
            </button>
            <button type="button" class="arp-btn" data-test="arp-copy" @click.stop="emit('copy', c.text)">{{ t('pane.agentTerminal.copy', 'Copy') }}</button>
          </div>
        </div>
      </li>
    </ul>
  </div>
</template>
