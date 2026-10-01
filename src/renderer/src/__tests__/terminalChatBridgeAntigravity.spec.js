// Antigravity's (agy) terminal pane in the chat view: the pane has it, its own
// "/" commands, the keys its Stop / Allow / Deny type into it, its model
// picked from the chat view, and its questions answered in its terminal.
import { describe, expect, it } from 'vitest'
import {
  CHAT_VIEW_AGENTS,
  KEY_ESCAPE,
  answerKeyGroups,
  askInTerminalFromEvents,
  bridgeSlashCommands,
  canShowChatView,
  cardKeys,
  commandDelivery,
  composerAgent,
  hasModePicker,
  keysAllowed,
  ownModelPicker,
  waitingCard
} from '../chat/terminalChatBridge'
import { detectApproval } from '../agentLimit'
import { getAgentSessionOptionCatalog } from '../../../shared/agentSessionOptions'

describe('Antigravity in the terminal chat view', () => {
  it('an Antigravity pane Tessel started on this computer has the chat view', () => {
    expect(CHAT_VIEW_AGENTS).toContain('antigravity')
    expect(canShowChatView({ kind: 'agent', agentId: 'antigravity' })).toBe(true)
    expect(canShowChatView({ kind: 'agent', agentId: 'antigravity', detected: true })).toBe(false)
    expect(canShowChatView({ kind: 'agent', agentId: 'antigravity', remoteHostId: 'ssh-1' })).toBe(false)
  })

  it('its own composer agent, commands typed key by key, the chat view picks its model, no mode picker', () => {
    expect(composerAgent('antigravity')).toBe('antigravity')
    expect(commandDelivery('antigravity', '/model')).toBe('type')
    expect(commandDelivery('antigravity', '/add-dir C:\\x')).toBe('type')
    expect(commandDelivery('antigravity', 'hello')).toBe(null)
    expect(commandDelivery('antigravity', '/clear', 1)).toBe(null)
    expect(ownModelPicker('antigravity')).toBe(false)
    expect(hasModePicker('antigravity')).toBe(false)
  })

  it('a model picked in the chat view is typed as "/model <id>" (switched at once)', () => {
    const mid = getAgentSessionOptionCatalog('antigravity').modelApply.midSession
    expect(mid.kind).toBe('command')
    expect(mid.build('gemini-3-flash-high')).toBe('/model gemini-3-flash-high')
  })

  it("lists Antigravity's own slash commands, model first, none of Claude Code's", () => {
    const list = bridgeSlashCommands('antigravity', { options: ['model', 'effort'] })
    const names = list.map((c) => c.name)
    expect(names[0]).toBe('model')
    for (const n of ['planning', 'fast', 'clear', 'resume', 'rewind', 'btw', 'add-dir', 'help']) expect(names).toContain(n)
    for (const n of ['compact', 'init', 'effort']) expect(names).not.toContain(n)
    expect(list.every((c) => c.kind === 'command' && c.description)).toBe(true)
  })

  it('Stop is Escape (Ctrl+C would quit it), Allow is "y", Deny is "n"', () => {
    expect(cardKeys('antigravity')).toEqual({ stop: KEY_ESCAPE, allow: 'y', deny: 'n' })
    expect(Object.values(cardKeys('antigravity')).some((k) => k.includes('\x03'))).toBe(false)
    expect(keysAllowed(cardKeys('antigravity').stop, 1000, 1001)).toBe(true)
  })

  it('its approval titles on screen hold delivery and show the card', () => {
    for (const title of ['Run this command?', 'Allow access to this URL?', 'Allow calling this tool?', 'Approve this action?']) {
      expect(detectApproval(`agy\n${title}\n  Yes, allow\n  No, deny`)).toBe(true)
    }
    expect(detectApproval('Ran the command. All tests passed.')).toBe(false)
  })

  it('its questions (ask_question) are answered in its terminal: no card keys, a "answer it there" card', () => {
    const prompt = { questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] }
    expect(answerKeyGroups('antigravity', prompt, [['A']])).toEqual([])
    const asking = [
      { type: 'user', id: 'u1', text: 'go' },
      { type: 'tool', id: 't1', name: 'ask_question', status: 'running' }
    ]
    expect(askInTerminalFromEvents('antigravity', asking)).toBe(true)
    expect(waitingCard({ input: askInTerminalFromEvents('antigravity', asking), working: true })).toEqual({ kind: 'terminal' })
    // Answered (its result came), a new prompt, a stopped turn, another agent: no card.
    expect(askInTerminalFromEvents('antigravity', [...asking, { type: 'toolResult', id: 't1', text: 'A' }])).toBe(false)
    expect(askInTerminalFromEvents('antigravity', [...asking, { type: 'user', id: 'u2', text: 'never mind' }])).toBe(false)
    expect(askInTerminalFromEvents('antigravity', [...asking, { type: 'turnEnd', status: 'interrupted' }])).toBe(false)
    expect(askInTerminalFromEvents('antigravity', [...asking, { type: 'tool', id: 't1', status: 'done' }])).toBe(false)
    expect(askInTerminalFromEvents('cursor', asking)).toBe(false)
    expect(askInTerminalFromEvents('antigravity', [{ type: 'tool', id: 't2', name: 'run_command', status: 'running' }])).toBe(false)
  })
})
