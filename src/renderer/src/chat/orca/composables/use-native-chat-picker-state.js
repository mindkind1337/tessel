// After Orca's use-native-chat-picker-state.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Reactive data options; callback setters accept values. textareaRef uses Vue refs.
// Returns computed autocomplete, listboxId and reference completion/history methods.
// skillsOptions injects local discovery; sessionSkillNames needs no host scanner.
import { computed, ref, watch, useId, nextTick, proxyRefs } from 'vue'
import { getNativeChatAgentProfile } from '../shared/native-chat-agent-profiles.js'
import {
  applyPickerSuggestion,
  classifyNativeChatSend,
  deriveComposerAutocomplete,
  editReplacesTriggerToken,
  isSkillPickerTriggered,
} from '../native-chat-composer-state.js'
import { useNativeChatSkills } from './use-native-chat-skills.js'
import { composerOptions } from './composer-options.js'
export function useNativeChatPickerState(options) {
  const { read, call } = composerOptions(options)
  const profile = computed(() => getNativeChatAgentProfile(read('agent')))
  const triggered = computed(() =>
    isSkillPickerTriggered(read('draft', '').slice(0, read('caret', 0)), profile.value),
  )
  const discovery = proxyRefs(
    useNativeChatSkills(
      () => read('agent'),
      () => read('terminalTabId'),
      triggered,
      () => read('skillsOptions', {}),
    ),
  )
  const listboxId = `native-chat-picker-${useId()}` // i18n-ignore
  const context = computed(() => JSON.stringify([read('draftScopeKey'), read('agent')]))
  const dismissed = ref(null),
    skillOrigin = ref(null)
  const derive = (draft, caret, dismissal) =>
    deriveComposerAutocomplete(
      draft,
      caret,
      read('agentCommands', []),
      discovery.skills,
      profile.value,
      discovery,
      dismissal,
      read('sessionSkillNames'),
    )
  const autocomplete = computed(() =>
    derive(
      read('draft', ''),
      read('caret', 0),
      dismissed.value?.context === context.value ? dismissed.value.triggerKey : null,
    ),
  )
  watch(
    context,
    () => {
      skillOrigin.value = null
      dismissed.value = null
    },
    { flush: 'sync' },
  )
  function completeItem(item) {
    if (autocomplete.value.mode !== 'slash') return
    const result = applyPickerSuggestion(read('draft', ''), read('caret', 0), item)
    const textarea = read('textareaRef'),
      owner = context.value
    if (item.kind === 'skill' && textarea?.insertSkill)
      textarea.insertSkill(
        result.caret - result.insertedToken.length - 1,
        read('caret'),
        result.insertedToken,
      )
    call('setDraft', result.draft)
    call('setCaret', result.caret)
    call('setActiveSuggestion', 0)
    dismissed.value = null
    skillOrigin.value = item.kind === 'skill' ? result.insertedToken : null
    textarea?.focus()
    nextTick(() => {
      if (
        context.value === owner &&
        read('textareaRef') === textarea &&
        read('draft') === result.draft
      )
        textarea?.setSelectionRange(result.caret, result.caret)
    })
  }
  function handleDraftOrCaretChange(value, caret) {
    if (skillOrigin.value && value.split(/\s/, 1)[0] !== skillOrigin.value) skillOrigin.value = null
    if (!dismissed.value || dismissed.value.context !== context.value) return
    const next = derive(value, caret, null)
    if (
      editReplacesTriggerToken(read('draft'), value, dismissed.value.triggerKey) ||
      next.mode !== 'slash' ||
      next.triggerKey !== dismissed.value.triggerKey
    )
      dismissed.value = null
  }
  return {
    autocomplete,
    listboxId,
    retrySkills: discovery.retry,
    classifySend: (value) =>
      classifyNativeChatSend(
        value,
        read('agentCommands', []),
        skillOrigin.value,
        profile.value?.skillPrefix ?? null,
      ),
    clearSkillOrigin: () => {
      skillOrigin.value = null
    },
    completeItem,
    dismiss: (triggerKey) => {
      dismissed.value = { context: context.value, triggerKey }
    },
    handleDraftOrCaretChange,
  }
}
