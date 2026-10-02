<script setup>
// After Orca's use-native-chat-context-menu.tsx (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The chat's right-click menu, opened where the pointer is: Copy (the text
// selected in the chat, or the last selection made there), Paste (into the
// composer), then the pane's own actions as Tessel has them (split right or
// down, maximize or restore, continue in a terminal, close).
// Props: rootEl (the chat's root, whose selection counts), enabled (a
//   hidden pane shows no menu), actions { onPaste, onSplitRight, onSplitDown,
//   isPaneExpanded, onToggleExpand, onSwitchToTerminal?, onClosePane? }.
// Exposed: onContextMenu(event) (bind it on the root, capture phase),
//   rememberSelection() (on mouseup/keyup: the selection a right-click would
//   otherwise clear).
import { computed, inject, onBeforeUnmount, onMounted, reactive, toValue, watch } from 'vue'
import { Clipboard, Copy, FolderOpen, Link2, Maximize2, Minimize2, PanelBottomClose, PanelRightClose, SquareTerminal, X } from 'lucide-vue-next'
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuShortcut, DropdownMenuTrigger } from './ui/index.js'
import { isMacPlatform } from '../../../chat/orca/native-chat-shortcut.js'
import { t } from '../../../i18n'
import { routeNativeChatHref } from '../../../chat/orca/shared/native-chat-href-routing.js'
import { parseExplicitFileLinkTarget, resolveExplicitFileLinkTarget } from '../../../chat/orca/lib/explicit-file-link-target.js'
import { chatPathProblem } from '../../../../../shared/chatFileLinks.js'

const props = defineProps({
  rootEl: { type: Object, default: null },
  enabled: { type: Boolean, default: true },
  actions: { type: Object, default: () => ({}) }
})

const state = reactive({ open: false, x: 0, y: 0, selectedText: '', filePath: '' })
// Tessel: a right-click on a file link offers its folder and its path. The
// link resolves as a click does (the chat's folder for a relative path).
const linkContext = inject('nativeChatFileLinkContext', null)
function fileOfLink(target) {
  const a = target && typeof target.closest === 'function' ? target.closest('a[href]') : null
  if (!a) return ''
  const route = routeNativeChatHref(a.getAttribute('href'))
  if (!route || route.kind !== 'file') return ''
  if (chatPathProblem(route.pathText, { requireAbsolute: false })) return ''
  const owner = toValue(linkContext)
  const parsed = parseExplicitFileLinkTarget(route.pathText, { allowRelativeDirectoryPath: true })
  if (!parsed || !owner || !owner.worktreePath || owner.remote) return ''
  const resolved = resolveExplicitFileLinkTarget(parsed, owner.worktreePath, owner.homePath)
  const path = resolved && resolved.absolutePath
  return path && !chatPathProblem(path) ? path : ''
}
function revealFile() {
  const api = window.shellApi && window.shellApi.chatFiles
  if (state.filePath && api && typeof api.reveal === 'function') api.reveal(state.filePath)
}
function copyFilePath() {
  if (!state.filePath) return
  if (window.shellApi && typeof window.shellApi.writeClipboard === 'function') window.shellApi.writeClipboard(state.filePath)
  else if (navigator.clipboard) navigator.clipboard.writeText(state.filePath).catch(() => {})
}
let openedAt = 0
let lastSelectedText = ''

const copyShortcut = computed(() => (isMacPlatform() ? '⌘C' : 'Ctrl+C')) // i18n-ignore key names
const canCopy = computed(() => state.selectedText.trim().length > 0)
const triggerStyle = computed(() => ({ left: `${state.x}px`, top: `${state.y}px` }))

function selectedIn(root) {
  const selection = window.getSelection()
  if (!root || !selection || selection.isCollapsed) return ''
  if (!selection.anchorNode || !selection.focusNode) return ''
  if (!root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return ''
  return selection.toString()
}
function rememberSelection() {
  const text = selectedIn(props.rootEl)
  if (text.trim().length > 0) lastSelectedText = text
}

function onContextMenu(event) {
  if (!props.enabled) return
  event.preventDefault()
  event.stopPropagation()
  openedAt = Date.now()
  state.selectedText = selectedIn(props.rootEl) || lastSelectedText
  try {
    state.filePath = fileOfLink(event.target)
  } catch {
    state.filePath = ''
  }
  state.x = event.clientX
  state.y = event.clientY
  state.open = true
}
// The right button's own release must not close what it just opened.
function setOpen(open) {
  if (!open && Date.now() - openedAt < 100) return
  state.open = open
}
watch(
  () => props.enabled,
  (enabled) => {
    if (!enabled) state.open = false
  }
)

function copy() {
  const text = state.selectedText
  if (!text.trim()) return
  if (window.shellApi && typeof window.shellApi.writeClipboard === 'function') window.shellApi.writeClipboard(text)
  else if (navigator.clipboard) navigator.clipboard.writeText(text).catch(() => {})
}
function run(name) {
  const action = props.actions && props.actions[name]
  if (typeof action === 'function') action()
}

onMounted(() => document.addEventListener('selectionchange', rememberSelection))
onBeforeUnmount(() => document.removeEventListener('selectionchange', rememberSelection))

defineExpose({ onContextMenu, rememberSelection })
</script>

<template>
  <DropdownMenu :open="enabled && state.open" :modal="false" @update:open="setOpen">
    <DropdownMenuTrigger as-child>
      <button aria-hidden="true" tabindex="-1" class="nc-context-anchor" :style="triggerStyle" type="button" />
    </DropdownMenuTrigger>
    <DropdownMenuContent class="nc-context-menu" :side-offset="0" align="start" data-test="chat-context-menu" @close-auto-focus="(e) => e.preventDefault()">
      <template v-if="state.filePath">
        <DropdownMenuItem data-test="chat-context-reveal" @select="revealFile">
          <FolderOpen />
          {{ t('chat.orca.contextMenu.revealFile', 'Show in Folder') }}
        </DropdownMenuItem>
        <DropdownMenuItem data-test="chat-context-copy-path" @select="copyFilePath">
          <Link2 />
          {{ t('chat.orca.contextMenu.copyPath', 'Copy Path') }}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
      </template>
      <DropdownMenuItem :disabled="!canCopy" @select="copy">
        <Copy />
        {{ t('chat.orca.contextMenu.copy', 'Copy') }}
        <DropdownMenuShortcut>{{ copyShortcut }}</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem @select="run('onPaste')">
        <Clipboard />
        {{ t('chat.orca.contextMenu.paste', 'Paste') }}
      </DropdownMenuItem>
      <DropdownMenuItem v-if="actions.onSwitchToTerminal" @select="run('onSwitchToTerminal')">
        <SquareTerminal />
        {{ t('chat.orca.contextMenu.switchToTerminal', 'Continue in a terminal') }}
      </DropdownMenuItem>
      <DropdownMenuSeparator />
      <DropdownMenuItem @select="run('onSplitRight')">
        <PanelRightClose />
        {{ t('chat.orca.contextMenu.splitRight', 'Split Right') }}
        <DropdownMenuShortcut>Ctrl+Shift+E</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem @select="run('onSplitDown')">
        <PanelBottomClose />
        {{ t('chat.orca.contextMenu.splitDown', 'Split Down') }}
        <DropdownMenuShortcut>Ctrl+Shift+O</DropdownMenuShortcut>
      </DropdownMenuItem>
      <DropdownMenuItem v-if="actions.onToggleExpand" @select="run('onToggleExpand')">
        <Minimize2 v-if="actions.isPaneExpanded" />
        <Maximize2 v-else />
        {{ actions.isPaneExpanded ? t('chat.orca.contextMenu.collapsePane', 'Restore Pane') : t('chat.orca.contextMenu.expandPane', 'Maximize Pane') }}
      </DropdownMenuItem>
      <template v-if="actions.onClosePane">
        <DropdownMenuSeparator />
        <DropdownMenuItem variant="destructive" @select="run('onClosePane')">
          <X />
          {{ t('chat.orca.contextMenu.closePane', 'Close Pane') }}
        </DropdownMenuItem>
      </template>
    </DropdownMenuContent>
  </DropdownMenu>
</template>

<style scoped>
/* pointer-events-none fixed size-px opacity-0 */
.nc-context-anchor {
  pointer-events: none;
  position: fixed;
  width: 1px;
  height: 1px;
  opacity: 0;
  padding: 0;
  border: 0;
}
/* w-56 */
.nc-context-menu {
  width: 224px;
}
</style>
