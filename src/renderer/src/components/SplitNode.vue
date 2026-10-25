<script>
export default { name: 'SplitNode' }
</script>

<script setup>
// One pane of the tree: a code editor, a browser page, a chat agent, a Live
// Share host's page or chat, or a real terminal. The grid places the panes
// and draws the dividers (PaneGrid.vue); an editor or browser tab is one of
// these alone in its room.
import TerminalPane from './TerminalPane.vue'
import EditorPane from './EditorPane.vue'
import BrowserPane from './BrowserPane.vue'
import ChatPane from './chat/ChatPane.vue'
import LiveShareChatPane from './LiveShareChatPane.vue'
import LiveSharePageView from './LiveSharePageView.vue'

defineProps({
  node: { type: Object, required: true }
})
</script>

<template>
  <EditorPane v-if="node.kind === 'editor'" :key="node.id" :node="node" />
  <BrowserPane v-else-if="node.kind === 'browser'" :key="node.id" :node="node" />
  <ChatPane v-else-if="node.kind === 'chat'" :key="node.id" :node="node" />
  <!-- A Live Share host's browser page: its frames, no page here -->
  <LiveSharePageView v-else-if="node.backend === 'liveshare' && node.liveShare && node.liveShare.page === true" :key="node.id + ':page'" :node="node" />
  <!-- A Live Share host's pane in chat mode: no terminal here -->
  <LiveShareChatPane v-else-if="node.backend === 'liveshare' && node.liveShare && node.liveShare.terminal === false" :key="node.id + ':chat'" :node="node" />
  <TerminalPane v-else :key="node.id + ':' + (node.gen || 0)" :node="node" />
</template>
