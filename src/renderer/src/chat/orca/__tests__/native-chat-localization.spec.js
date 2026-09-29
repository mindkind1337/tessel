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
import { afterEach, describe, expect, it } from 'vitest'
import { setMessages } from '../../../i18n/index.js'
import fr from '../../../i18n/locales/fr/chat.json'
import { getAgentSlashCommands } from '../shared/native-chat-slash-commands.js'
import { isInterruptedStatusMessage, NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from '../shared/native-chat-types.js'
import { backgroundTaskFallbackText, claimBackgroundTaskTwins } from '../shared/native-chat-background-task-row.js'
import { agentTurnLifecycleText } from '../shared/agent-turn-lifecycle-text.js'
import { nativeChatProtocolText, nativeChatTurnLifecycleText, nativeChatBackgroundTaskText } from '../native-chat-protocol-text.js'

afterEach(() => setMessages('en', {}))

describe('localized display preserves the transcript protocol', () => {
  it('updates imported command descriptions when the language changes', () => {
    setMessages('en', {})
    const command = getAgentSlashCommands('claude').find(item => item.name === 'clear')
    const english = command.description
    setMessages('fr', fr)
    expect(command.description).toBe('Effacer l’historique de la conversation')
    setMessages('en', {})
    expect(command.description).toBe(english)
  })

  it('recognizes the English interruption marker and translates only its display', () => {
    setMessages('fr', fr)
    expect(NATIVE_CHAT_INTERRUPTED_STATUS_TEXT).toBe('Conversation interrupted')
    expect(isInterruptedStatusMessage({ role: 'system', blocks: [{ type: 'text', text: 'Conversation interrupted' }] })).toBe(true)
    expect(nativeChatProtocolText(NATIVE_CHAT_INTERRUPTED_STATUS_TEXT)).toBe('Conversation interrompue')
    expect(nativeChatProtocolText('provider-owned text')).toBe('provider-owned text')
    expect(agentTurnLifecycleText('Claude', 'completed')).toBe('Claude turn completed')
    expect(nativeChatTurnLifecycleText('Claude', 'completed')).toBe('Tour de Claude terminé')
  })

  it('deduplicates background task messages before translating their display', () => {
    const block = { type: 'background-task', taskId: 'task-1', kind: 'command', label: 'sleep 20', state: 'working' }
    setMessages('en', {})
    const sentence = backgroundTaskFallbackText(block)
    expect(nativeChatBackgroundTaskText(block)).toBe(sentence)
    setMessages('fr', fr)
    expect(backgroundTaskFallbackText(block)).toBe(sentence)
    expect(claimBackgroundTaskTwins([block, { type: 'text', text: sentence }]).twinTextIndexes.has(1)).toBe(true)
    expect(nativeChatBackgroundTaskText(block)).toBe('Démarré : commande en arrière-plan "sleep 20"')
    expect(nativeChatBackgroundTaskText({ ...block, summary: 'Provider status' })).toBe('Provider status')
  })
})
