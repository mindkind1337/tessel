// After Orca's use-native-chat-composer-catalog.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// agent/transport accept values, refs or getters; outputs are computed refs.
// Session-reported catalogs win. Fallback lists only explicitly supported actions.
// Dynamic provider descriptions remain provider data; local labels use t().
import { computed, toValue } from 'vue'
import {
  getVerifiedNativeChatCommands,
  getTextDrivenNativeChatCommands,
} from '../shared/native-chat-agent-profiles.js'
import {
  sessionReportedSkillNames,
  sessionSlashCommandSuggestions,
} from '../shared/native-chat-slash-commands.js'
import { t } from '../../../i18n/index.js'
export function useNativeChatComposerCatalog(agent, structuredTransport) {
  const transport = () => toValue(structuredTransport)
  const reported = () => toValue(transport()?.sessionCommands)
  const agentCommands = computed(() => {
    if (!transport()) return getVerifiedNativeChatCommands(toValue(agent))
    if (reported() !== undefined) return sessionSlashCommandSuggestions(toValue(agent), reported())
    const result = [...getTextDrivenNativeChatCommands(toValue(agent))]
    const actions = toValue(transport()?.conversationCommands) || []
    if (transport()?.setOption) {
      result.unshift(
        { name: 'model', description: t('chat.orca.catalog.model', 'Choose the model') },
        { name: 'effort', description: t('chat.orca.catalog.effort', 'Choose reasoning effort') },
      )
    }
    if (actions.includes('clear'))
      result.push({
        name: 'clear',
        description: t('chat.orca.catalog.clear', 'Start a fresh conversation'),
      })
    if (actions.includes('compact'))
      result.push({
        name: 'compact',
        description: t('chat.orca.catalog.compact', 'Compact conversation context'),
      })
    return result
  })
  const sessionSkillNames = computed(() =>
    reported() !== undefined ? sessionReportedSkillNames(reported()) : undefined,
  )
  return { agentCommands, sessionSkillNames }
}
