// After Orca's src/shared/native-chat-ask-row.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
//
// The native-chat row that stands in for a question tool call. Both platform
// UIs read this copy (desktop as its i18n fallbacks, mobile directly) so the two
// can never describe the same pending question differently.
import { isAskUserQuestionTool } from './agent-question-answered-intent.js'
import { parseAskFromToolInput } from './native-chat-ask.js'
import { isToolCallBlock } from './native-chat-types.js'
import { pairToolBlocks } from './native-chat-tool-fold.js'

export const NATIVE_CHAT_ASK_ROW_COPY = {
  awaiting: 'Awaiting user input:', // i18n-ignore
  asked: 'Asked:', // i18n-ignore
  questionCount: '{{value0}} questions' // i18n-ignore
}

// A subject is { kind: 'question', text } or { kind: 'count', count }: one row
// stands for the whole prompt, so a grouped prompt may not quote just its first
// question as though it were the only one.

/** Whether this block is a question tool call, and so is drawn as the awaiting
 *  row rather than as an ordinary tool line. */
export function isNativeChatAskCall(block) {
  return isToolCallBlock(block) && block.state !== 'failed' && isAskUserQuestionTool(block.name)
}

/** Remove each summarized call together with its FIFO result, preserving failed calls. */
export function nativeChatAskRunBlocks(blocks) {
  if (!blocks.some(isNativeChatAskCall)) {
    return { asks: [], unansweredAsks: [], work: blocks }
  }
  const removed = new Set()
  const asks = []
  const unansweredAsks = []
  for (const { call, result } of pairToolBlocks(blocks)) {
    if (!call || !isNativeChatAskCall(call) || result?.isError) {
      continue
    }
    asks.push(call)
    if (!result) {
      unansweredAsks.push(call)
    }
    removed.add(call)
    if (result) {
      removed.add(result)
    }
  }
  return {
    asks,
    unansweredAsks,
    work: removed.size ? blocks.filter((block) => !removed.has(block)) : blocks
  }
}

/** Whether this run asks the reader anything. Decided by the tool name alone,
 *  because that already says the agent is blocked on an answer — a payload this
 *  cannot parse must not put the raw call back on screen as the row it replaced. */
export function hasNativeChatAskCall(blocks) {
  return blocks.some(isNativeChatAskCall)
}

/** The questions one call names, dropping any it states blankly. */
function askCallQuestions(block) {
  if (!isToolCallBlock(block)) {
    return []
  }
  const prompt = parseAskFromToolInput(block.name, block.input)
  return prompt
    ? prompt.questions.map((question) => question.question.trim()).filter((text) => text.length > 0)
    : []
}

/**
 * The subject for the whole run's question activity, or null when nothing in it
 * names a question — the row then stands on its label alone, which still tells
 * the reader the turn is theirs to unblock.
 *
 * Aggregated across calls, not taken from one: Codex journals a separate call
 * per question of the same prompt, so a per-call row would stack three pulsing
 * lines for what the reader was asked once.
 */
export function nativeChatAskRunSubject(blocks) {
  const questions = blocks.filter(isNativeChatAskCall).flatMap(askCallQuestions)
  if (questions.length === 0) {
    return null
  }
  if (questions.length > 1) {
    return { kind: 'count', count: questions.length }
  }
  const text = questions[0]
  return text ? { kind: 'question', text } : null
}
