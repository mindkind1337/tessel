// After Orca's native-chat-turn-activity.ts (MIT, Copyright (c) 2026 Lovecast Inc.)
import { readAgentJournalTurn } from './agent-session-turn-record.js'

import { isRootAgentJournalItem } from './agent-session-journal-producer.js'
import { normalizePromptField } from './agent-status-field-normalization.js'
import { describeActiveToolCall, formatActiveToolLabel } from './native-chat-tool-activity.js'

function activityLine(text) {
  let end = text.length
  while (end > 0) {
    const start = text.lastIndexOf('\n', end - 1) + 1
    const latest = text.slice(start, end).trim()
    if (latest) {
      return normalizePromptField(latest) || null
    }
    if (start === 0) {
      break
    }
    end = start - 1
  }
  return null
}

function recentToolActivityLabels(items) {
  const labels = new Set()
  let foundRunning = false
  let foundSettled = false
  for (let index = items.length - 1; index >= 0 && (!foundRunning || !foundSettled); index -= 1) {
    const body = items[index]?.body
    if (body?.kind !== 'tool-call') {
      continue
    }
    const isRunning = body.state === 'running'
    if ((isRunning && foundRunning) || (!isRunning && foundSettled)) {
      continue
    }
    const descriptor = describeActiveToolCall({
      type: 'tool-call',
      name: body.name,
      input: body.input,
      state: body.state,
    })
    const candidates = [
      formatActiveToolLabel(descriptor),
      descriptor.preview,
      descriptor.preview ? `${descriptor.toolName} ${descriptor.preview}` : descriptor.toolName,
    ]
    for (const candidate of candidates) {
      const label = activityLine(candidate)?.toLowerCase()
      if (label) {
        labels.add(label)
      }
    }
    foundRunning ||= isRunning
    foundSettled ||= !isRunning
  }
  return labels
}

function repeatsRecentToolLabel(text, labels) {
  const normalized = text.toLowerCase()
  for (const label of labels) {
    if (
      normalized === label ||
      normalized.startsWith(`${label} `) ||
      normalized.endsWith(` ${label}`) ||
      normalized.includes(` ${label} `)
    ) {
      return true
    }
  }
  return false
}

/** Prefer provider-authored activity copy; callers provide the broad fallback. */
export function selectStructuredAgentTurnActivity(items, turnId, providerActivity) {
  if (!turnId) {
    return null
  }
  const turnStartIndex = items.findLastIndex((item) => {
    const turn = readAgentJournalTurn(item.body)
    return turn?.turnId === turnId && turn.state === 'running'
  })
  // Scoped ONCE, for everything below: this answers what the session's own agent
  // is doing. Both readers below consult the label set, so a subagent left in it
  // would let a child's tool label suppress the parent's own activity line —
  // child data deciding what the parent's surface shows.
  const turnItems = items.slice(Math.max(0, turnStartIndex)).filter(isRootAgentJournalItem)
  const toolLabels = recentToolActivityLabels(turnItems)
  if (providerActivity?.turnId === turnId) {
    const text = activityLine(providerActivity.text)
    if (text && !repeatsRecentToolLabel(text, toolLabels)) {
      return { kind: 'description', text }
    }
  }
  for (let index = turnItems.length - 1; index >= 0; index -= 1) {
    const body = turnItems[index]?.body
    if (body?.kind !== 'status' || readAgentJournalTurn(body) || body.providerFrame) {
      continue
    }
    const text = activityLine(body.text)
    if (text && !repeatsRecentToolLabel(text, toolLabels)) {
      return { kind: 'description', text }
    }
  }
  return null
}
