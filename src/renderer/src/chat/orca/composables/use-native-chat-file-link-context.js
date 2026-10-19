// After Orca's use-native-chat-file-link-context.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// pane and options accept values, refs/computed or getters. Pass a Tessel leaf.
// resolveContext(pane) may supply a local context instead of panelCtx.paneFolder.
// Returns computed { worktreeId, worktreePath, roots, runtimeEnvironmentId: null } or null.
import { computed, inject, toValue, unref } from 'vue'
import { chatRemoteRoot } from '../../remoteChatLinks.js'
import { remoteRoot } from '../../../../../shared/remotePath.js'

// The same context for a leaf without a component (Tessel: the
// Conversations tab, task cards and the activity log resolve each message's
// paths against the pane that wrote it). panel: App's panelCtx (or null).
export function fileLinkContextOf(leaf, panel = null, resolve = null) {
  // Tessel: a chat whose agent runs on an SSH host: its links are the
  // host's files, opened over the remote file system (remoteChatLinks.js).
  // A terminal opened on an SSH host (an agent started there): the same,
  // its host's folder, never the local folder the terminal started from.
  const hostRoot = leaf && (chatRemoteRoot(leaf.cwd) || (leaf.remoteHostId ? remoteRoot(leaf.remoteHostId, leaf.remotePath || '~') : null))
  if (hostRoot) return { worktreeId: leaf.id, worktreePath: hostRoot, roots: [hostRoot], runtimeEnvironmentId: null, remote: true, remoteRoot: hostRoot }
  // A host pane whose folder cannot be named: none of its paths opens (never
  // a local folder in its place).
  if (leaf && leaf.remoteHostId) return null
  const context = resolve
    ? resolve(leaf)
    : leaf && {
        worktreeId: leaf.id,
        // Tessel: a pane working in a worktree copy reads its links there
        // (the agent's "src/a.js" is the copy's, not the project checkout's).
        worktreePath: leaf.worktree?.path || panel?.paneFolder?.(leaf) || leaf.projectDir || leaf.cwd || leaf.startDir,
        // Tessel: the folders a link may open a file in (the pane's own).
        roots: [...new Set([leaf.worktree?.path, panel?.paneFolder?.(leaf), leaf.projectDir, leaf.cwd, leaf.startDir].filter((p) => typeof p === 'string' && p))],
        runtimeEnvironmentId: null,
        remote: leaf.remote,
      }
  if (!context?.worktreePath || context.remote || context.runtimeEnvironmentId) return null
  return context
}

export function useNativeChatFileLinkContext(pane, options = {}) {
  const panel = inject('panelCtx', null)
  return computed(() => fileLinkContextOf(toValue(pane), panel, unref(toValue(options).resolveContext)))
}
