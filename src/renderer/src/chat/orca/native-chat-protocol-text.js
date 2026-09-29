/*
 * MIT License
 *
 * Copyright (c) 2026 Lovecast Inc.
 *
 * Permission is hereby granted, free of charge, to any person obtaining a copy
 * of this software and associated documentation files (the "Software"), to deal
 * in the Software without restriction, including without limitation the rights
 * to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
 * copies of the Software, and to permit persons to whom the Software is
 * furnished to do so, subject to the following conditions:
 *
 * The above copyright notice and this permission notice shall be included in all
 * copies or substantial portions of the Software.
 *
 * THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 * IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 * FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 * AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 * LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 * OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 * SOFTWARE.
 */
import { t } from '../../i18n/index.js'
import { agentTurnLifecycleText } from './shared/agent-turn-lifecycle-text.js'
import { isSettledBackgroundTaskState, normalizeBackgroundTaskKind } from './shared/native-chat-background-task-row.js'

// These functions run at the display boundary, after recognition and grouping.
export function nativeChatProtocolText(text) {
  switch (text) {
    case 'Conversation interrupted': // i18n-ignore
      return t('chat.orca.copy.conversation_interrupted', 'Conversation interrupted')
    case 'Clipboard text is too large for this paste target.': // i18n-ignore
      return t('chat.orca.copy.clipboard_text_is_too_large_for_this_paste_target', 'Clipboard text is too large for this paste target.')
    case 'Clipboard text is too large to copy safely.': // i18n-ignore
      return t('chat.orca.copy.clipboard_text_is_too_large_to_copy_safely', 'Clipboard text is too large to copy safely.')
    default: return text
  }
}

export function nativeChatTurnLifecycleText(agent, state) {
  switch (state) {
    case 'running': return t('chat.orca.copy.agent_is_working', '{{agent}} is working…', { agent })
    case 'completed': return t('chat.orca.copy.agent_turn_completed', '{{agent}} turn completed', { agent })
    case 'interrupted': return t('chat.orca.copy.agent_turn_interrupted', '{{agent}} turn interrupted', { agent })
    case 'unverifiable': return t('chat.orca.copy.agent_turn_outcome_unverifiable', '{{agent}} turn outcome unverifiable', { agent })
    default: return agentTurnLifecycleText(agent, state)
  }
}

export function nativeChatBackgroundTaskText(block) {
  const sentence = block.summary?.trim() || block.error?.trim()
  if (sentence) return sentence
  const nouns = {
    agent: t('chat.orca.background.agent', 'background agent'),
    workflow: t('chat.orca.background.workflow', 'background workflow'),
    command: t('chat.orca.background.command', 'background command'),
    monitor: t('chat.orca.background.monitor', 'background monitor'),
    unknown: t('chat.orca.background.task', 'background task')
  }
  const noun = nouns[normalizeBackgroundTaskKind(block.kind)]
  let subject = block.label.trim() ? `${noun} "${block.label}"` : noun
  if (!isSettledBackgroundTaskState(block.state)) return t('chat.orca.copy.started_subject', 'Started {{subject}}', { subject })
  subject = subject.charAt(0).toUpperCase() + subject.slice(1)
  switch (block.state) {
    case 'done': return t('chat.orca.background.done', '{{subject}} finished', { subject })
    case 'blocked': return t('chat.orca.background.blocked', '{{subject}} failed', { subject })
    case 'idle': return t('chat.orca.background.idle', '{{subject}} was stopped', { subject })
    default: return t('chat.orca.background.unverifiable', '{{subject}} stopped reporting', { subject })
  }
}
