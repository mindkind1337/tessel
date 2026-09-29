// After Orca's use-native-chat-picker-command-dispatch.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options; sendStructured(text,[]) owns confirmed draft/history updates.
// onOptionCommand(name) opens an option picker; bare /model never reaches the model.
// Returns an async command handler; no PTY, bridge, or speculative clearing.
import { composerOptions } from './composer-options.js'
export function useNativeChatPickerCommandDispatch(options) {
  const { read, call, blocked, scope } = composerOptions(options)
  return async (command) => {
    if (blocked() || read('isDispatchingSessionOption')) return { ok: false }
    if (['model', 'effort', 'permissionMode'].includes(command.name))
      return call('onOptionCommand', command.name)
    const owner = scope()
    const result = await call('sendStructured', `/${command.name}`, [])
    if (result?.ok === true && scope() === owner) {
      call('setActiveSuggestion', 0)
      call('onSlashCommand', `/${command.name}`)
      call('setNotice', null)
    }
    return result || { ok: false }
  }
}
