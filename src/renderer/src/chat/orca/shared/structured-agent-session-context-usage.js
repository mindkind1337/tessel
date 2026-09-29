// After Orca's structured-agent-session-context-usage.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
// The context window a structured session reads from its own journal's turn
// rows. Facts are written only to the open or newest turn and each write
// replaces its namesake, so the newest row carrying a part holds its current
// value. Nothing is held outside the journal, so a restart replays the same answer.

import { contextTokensFromUsage } from './agent-session-context-usage.js'

import { readAgentJournalTurn } from './agent-session-turn-record.js'

/** The newest of each part these rows carry, in any order; a part none of them carries is absent. */
export function latestStructuredAgentContextFacts(items) {
  let used = null
  let window = null
  for (const item of items) {
    const facts = readAgentJournalTurn(item.body)?.contextUsage
    if (facts?.used && (used === null || item.sequence >= used.sequence)) {
      used = { sequence: item.sequence, fact: facts.used }
    }
    if (facts?.window && (window === null || item.sequence >= window.sequence)) {
      window = { sequence: item.sequence, fact: facts.window }
    }
  }
  return { ...(used ? { used: used.fact } : {}), ...(window ? { window: window.fact } : {}) }
}

/**
 * The ring's reading of the loaded rows, with `wholeJournal` (the host's answer
 * over every row) filling any part they lack. The loaded window reaches the live
 * head, so a part found in it is newer than the host's; the host's covers only
 * rows older than the window.
 */
export function selectStructuredAgentContextUsage(items, wholeJournal) {
  const loaded = latestStructuredAgentContextFacts(items)
  return summarizeStructuredAgentContextFacts({ ...wholeJournal, ...loaded })
}

function summarizeStructuredAgentContextFacts({ used: fact, window }) {
  if (fact?.kind === 'report') {
    return {
      usedTokens: fact.usedTokens,
      windowTokens: fact.windowTokens,
      percentage: fact.percentage,
      estimated: false,
      categories: fact.categories,
    }
  }
  // `unknown`, or a kind a newer host writes that this client cannot measure.
  if (fact?.kind !== 'estimate') {
    return null
  }
  // The writer holds estimates back across a model change, so the newest window is this model's.
  if (!window) {
    return null
  }
  const usedTokens = contextTokensFromUsage(fact.usage)
  return {
    usedTokens,
    windowTokens: window.tokens,
    percentage: Math.round((usedTokens / window.tokens) * 100),
    estimated: true,
    categories: [],
  }
}
