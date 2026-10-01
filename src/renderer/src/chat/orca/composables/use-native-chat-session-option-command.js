// After Orca's use-native-chat-session-option-command.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive options; setOption(payload) is the only mutation callback.
// dispatch({optionId,value}), dispatch({values:{model,effort}}), or a slash
// command returns {ok,...}. A values object uses one setOption request.
// confirmedValues changes only after ok:true; permission caps are checked locally too.
import { ref, watch, onScopeDispose } from 'vue'
import { t } from '../../../i18n/index.js'
import { composerOptions } from './composer-options.js'
export function useNativeChatSessionOptionCommand(options) {
  const { read, fn, call, scope } = composerOptions(options)
  const isDispatching = ref(false),
    confirmedValues = ref({})
  let alive = true
  onScopeDispose(() => {
    alive = false
  })
  watch(
    () => [scope(), read('values'), read('permissionMode')],
    () => {
      confirmedValues.value = {
        ...read('values', {}),
        ...(read('permissionMode') ? { permissionMode: read('permissionMode') } : {}),
      }
    },
    { immediate: true, flush: 'sync', deep: true },
  )
  function modeBlocked(mode) {
    const node = read('node', {}),
      agent = read('agent', node.agentId || 'claude')
    const choices =
      agent === 'codex'
        ? ['default', 'bypassPermissions']
        : agent === 'opencode'
          ? ['default', 'plan', 'bypassPermissions']
          : ['default', 'acceptEdits', 'plan', 'auto', 'bypassPermissions']
    if (!choices.includes(mode))
      return t('chat.orca.options.unsupported', 'This option is not available for this agent.')
    if (mode === 'bypassPermissions' && !read('chatLaunchYolo', node.chatLaunchYolo))
      return t(
        'chat.mode.yoloOnlyAtStart',
        `Yolo only for a chat started in Yolo (Settings > Agents)`,
      )
    if (
      ['bypassPermissions', 'auto'].includes(mode) &&
      read('maxPermissions', node.maxPermissions) === 'manual'
    )
      return t('chat.mode.capped', 'Not more than its coordinator allows')
    if (agent === 'codex' && read('isWorking', read('busy', false)) && mode === 'bypassPermissions')
      return t('chat.mode.codexBusy', 'Wait for the end of the turn: switching now would stop it')
    return ''
  }
  function refuse(error) {
    call('setNotice', error)
    call('onError', error)
    return { ok: false, error }
  }
  async function dispatch(command) {
    if (
      !alive ||
      isDispatching.value ||
      read('disabled') ||
      read('disabledReason') ||
      read('sendBlockedReason')
    )
      return { ok: false }
    let optionId, value
    if (typeof command === 'string') {
      const match = /^\/(model|effort|permissionMode)\s+(.+)$/.exec(command.trim())
      if (match) [, optionId, value] = match
    } else {
      optionId = command?.optionId
      value = command?.value
    }
    const values = command && typeof command === 'object' && command.values
      ? command.values : { [optionId]: value }
    const entries = Object.entries(values)
    if (!entries.length || entries.some(([id, next]) => !['model', 'effort', 'permissionMode'].includes(id) || typeof next !== 'string' || !next.trim()))
      return refuse(
        t('chat.orca.options.unsupported', 'This option is not available for this agent.'),
      )
    const why = values.permissionMode ? modeBlocked(values.permissionMode) : ''
    if (why) return refuse(why)
    if (!fn('setOption'))
      return refuse(t('chat.orca.options.unavailable', 'Session options are unavailable.'))
    const owner = scope()
    isDispatching.value = true
    try {
      const result = await call('setOption', { ...values })
      if (!alive || scope() !== owner) return result || { ok: false }
      if (result?.ok !== true)
        return refuse(
          result?.error || t('chat.orca.options.rejected', 'The option did not change.'),
        )
      confirmedValues.value = { ...confirmedValues.value, ...values }
      for (const [id, next] of entries) call('onConfirmed', id, next)
      call('setNotice', null)
      call('onError', null)
      return result
    } catch (error) {
      return alive && scope() === owner ? refuse(String(error?.message || error)) : { ok: false }
    } finally {
      isDispatching.value = false
    }
  }
  return { dispatch, isDispatching, confirmedValues, modeBlocked }
}
