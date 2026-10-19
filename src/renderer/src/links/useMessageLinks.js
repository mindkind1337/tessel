// Opening what a message outside the chat shares (the Conversations tab,
// its Media view, Past conversations, task card reports, the activity log)
// the way the chat opens it: a path through the chat's file link checks
// (use-native-chat-file-link-click.js: resolved against the folder of the
// pane that wrote it, a worktree copy's when it works in one; refused when it
// is a program, asked first outside that folder; a folder to the Files tab,
// an image to the viewer, a PDF to its window), a web page or a mail address
// through the link router (openTarget.js), a data: image to the viewer.
// A Live Share guest (guest: true) opens web pages only, through the host's
// link filtering (App's openGuestUrl); a host's path never opens here.
// A message of an agent on an SSH host (its pane's host, or the host its
// sender record names: senderIdentity.js) names that host's files: they open
// there, over the remote file system (remoteChatLinks.js), only while Tessel
// is connected to it; never a file of this computer with the same name.
import { inject } from 'vue'
import { openTarget } from './openTarget.js'
import { fileLinkContextOf } from '../chat/orca/composables/use-native-chat-file-link-context.js'
import { useNativeChatFileLinkClick } from '../chat/orca/composables/use-native-chat-file-link-click.js'
import { createNativeChatFileHref } from '../chat/orca/shared/native-chat-href-routing.js'
import { formatFileLinkLocation } from '../chat/orca/shared/file-link-location.js'
import { t } from '../i18n/index.js'
import { paneRemote } from '../senderIdentity.js'
import { remoteRoot } from '../../../shared/remotePath.js'

const quietEvent = () => ({ preventDefault() {}, stopPropagation() {}, ctrlKey: false, metaKey: false })

export function useMessageLinks() {
  const panel = inject('panelCtx', null)
  let current = null
  const fileClick = useNativeChatFileLinkClick(() => current)
  // One object per folder set, so a rendered message keeps the same context
  // (ChatMarkdown looks its inline code up again when it changes).
  const contexts = new Map()
  function stable(ctx) {
    if (!ctx) return null
    const key = [ctx.worktreeId || '', ctx.worktreePath, ...(ctx.roots || []), ctx.remoteRoot || '', ctx.remoteHost ? `${ctx.remoteHost.id || ''}|${ctx.remoteHost.label || ''}` : ''].join('\u0000')
    if (!contexts.has(key)) {
      if (contexts.size > 200) contexts.clear()
      contexts.set(key, ctx)
    }
    return contexts.get(key)
  }
  // An SSH host's folder as a message's context. host: { hostId, path,
  // label }; without a hostId (an older record), a context whose paths are
  // links that open nothing (the click says where they are).
  function hostContext(id, host) {
    const hostId = typeof host.hostId === 'string' ? host.hostId : null
    const state = hostId && panel && typeof panel.remoteHostState === 'function' ? panel.remoteHostState(hostId) : null
    const remoteHost = { id: hostId, label: (state && state.saved && state.label) || host.label || hostId || '' }
    const root = hostId ? remoteRoot(hostId, host.path || '~') : null
    return { worktreeId: id || root || '', worktreePath: root, roots: root ? [root] : [], runtimeEnvironmentId: null, remote: true, remoteRoot: root, remoteHost }
  }
  // The folder a pane's message is read against: its pane open now (its
  // worktree copy, an SSH host's folder), else the SSH host it ran on (host:
  // { hostId, path, label }, from its sender record or its card's report),
  // else `folder` (its project's; `remote`: a host's project, its
  // { hostId, path, host } or true), else none (its paths are not links). A
  // message from an SSH host is never read against a folder of this computer.
  function contextFor(paneId, { folder = null, remote = false, host = null } = {}) {
    const leaf = paneId && panel && typeof panel.findLeaf === 'function' ? panel.findLeaf(paneId) : null
    if (leaf) {
      const onHost = paneRemote(leaf)
      if (!onHost) return stable(fileLinkContextOf(leaf, panel))
      const own = fileLinkContextOf(leaf, panel)
      const ctx = hostContext(leaf.id, { hostId: onHost.hostId, path: onHost.path })
      return stable(own && own.remoteRoot ? { ...own, remoteHost: ctx.remoteHost } : ctx)
    }
    if (host && typeof host === 'object') return stable(hostContext(paneId, host))
    if (remote && typeof remote === 'object' && remote.hostId) return stable(hostContext(paneId, { hostId: remote.hostId, path: remote.path, label: remote.host }))
    if (remote || typeof folder !== 'string' || !folder) return null
    return stable(fileLinkContextOf({ id: paneId || folder, cwd: folder }, null))
  }
  // A path, read against `context` (none: an absolute path, through the
  // router).
  // folder: a folder by its look (a Media item); on an SSH host, where
  // nothing is looked up first, it goes to the Files tab.
  function openPath({ path, line = null, col = null, folder = false }, context, event = null) {
    const e = event || quietEvent()
    if (context) {
      current = context
      const pathText = folder && context.remoteRoot && !/[\\/]$/.test(path) ? `${path}/` : path
      return fileClick.value(e, createNativeChatFileHref(formatFileLinkLocation({ pathText, line: line ?? null, column: col ?? null })))
    }
    if (!/^(?:[A-Za-z]:[\\/]|\/(?!\/)|~[\\/])/.test(path)) {
      panel?.toast?.(t('chat.orca.fileLinks.unresolved', 'Could not resolve {{value0}} in this workspace', { value0: path }), { kind: 'error' })
      return false
    }
    return openTarget({ path, line, col }, { event: e })
  }
  function openUrl(url, event = null, guest = false) {
    if (guest) return panel && typeof panel.openGuestUrl === 'function' ? panel.openGuestUrl(url, {}) : false
    // App's router (panelCtx.openTarget, as the chat's links), else the window's.
    const open = panel && typeof panel.openTarget === 'function' ? panel.openTarget : openTarget
    return open(url, { event: event || quietEvent() })
  }
  // A Media item (messageMedia.js) or a link's href.
  function openItem(item, context, event = null, { guest = false } = {}) {
    if (!item) return false
    if (item.url) return openUrl(item.url, event, guest)
    if (item.src) return openTarget({ src: item.src }, { event: event || quietEvent(), label: item.label || '' })
    if (item.path && !guest) return openPath({ ...item, folder: item.type === 'folder' }, context, event)
    return false
  }
  return { contextFor, openPath, openUrl, openItem, panel }
}
