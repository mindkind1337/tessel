// After Orca's use-native-chat-file-link-context.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// pane and options accept values, refs/computed or getters. Pass a Tessel leaf.
// resolveContext(pane) may supply a local context instead of panelCtx.paneFolder.
// Returns computed { worktreeId, worktreePath, runtimeEnvironmentId: null } or null.
import { computed, inject, toValue, unref } from 'vue'

export function useNativeChatFileLinkContext(pane, options = {}) {
  const panel = inject('panelCtx', null)
  return computed(() => {
    const leaf = toValue(pane)
    const resolve = unref(toValue(options).resolveContext)
    const context = resolve
      ? resolve(leaf)
      : leaf && {
          worktreeId: leaf.id,
          worktreePath: panel?.paneFolder?.(leaf) || leaf.projectDir || leaf.cwd || leaf.startDir,
          runtimeEnvironmentId: null,
          remote: leaf.remote,
        }
    if (!context?.worktreePath || context.remote || context.runtimeEnvironmentId) return null
    return context
  })
}
