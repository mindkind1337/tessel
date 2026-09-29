// After Orca's use-native-chat-assembled-messages.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// Inputs accept plain values, refs/computed or getters; options may be reactive.
// DOM refs use .value. Callbacks keep their original call signatures.
// Returns a stable object; state fields are refs/computed, actions are functions.
import { computed, toValue } from 'vue'
import {
  applyAppends,
  createIncrementalAssembler,
  reset as resetAssembler,
} from '../native-chat-incremental-assembler.js'
import { prepareNativeChatLiveMessages } from '../native-chat-live-message-preparation.js'

function cloneAssembler(assembler) {
  return {
    byId: new Map(assembler.byId),
    byTurn: new Map(assembler.byTurn),
    messages: assembler.messages,
  }
}

function sharesPrefix(whole, prefix, length) {
  for (let index = 0; index < length; index += 1) {
    if (whole[index] !== prefix[index]) return false
  }
  return true
}

export function useNativeChatAssembledMessages(options) {
  const read = (key) => toValue(toValue(options)[key])
  let cache = null
  // Vue computed evaluation is synchronous; retain the last completed assembly.
  const assembledMessages = computed(() => {
    const agent = read('agent')
    const sessionId = read('sessionId')
    const baseMessages = read('baseMessages')
    const appended = read('appended')
    const transcript = appended.length > 0 ? [...baseMessages, ...appended] : baseMessages
    const baseSignature = `${agent}\u0000${sessionId ?? ''}`
    const baseChanged =
      !cache || baseSignature !== cache.baseSignature || baseMessages !== cache.baseMessages
    const applied = cache?.transcript ?? []
    const suffix =
      !baseChanged &&
      transcript.length >= applied.length &&
      sharesPrefix(transcript, applied, applied.length)
    const assembler = baseChanged ? createIncrementalAssembler() : cloneAssembler(cache.assembler)
    const messages = suffix
      ? transcript.length > applied.length
        ? applyAppends(assembler, transcript.slice(applied.length))
        : assembler.messages
      : resetAssembler(assembler, transcript)
    cache = { assembler, baseSignature, baseMessages, transcript }
    return messages
  })
  const normalizedMessages = computed(() =>
    prepareNativeChatLiveMessages(assembledMessages.value, read('agent')),
  )
  return { assembledMessages, normalizedMessages }
}
