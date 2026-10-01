// Cursor CLI's terminal pane in the chat view: the pane has it, its own "/"
// commands, and the keys its Stop / Allow / Deny type into it.
import { describe, expect, it } from 'vitest'
import {
  CHAT_VIEW_AGENTS,
  INTERRUPT_GAP_MS,
  KEY_ALLOW,
  KEY_CTRL_C,
  KEY_ESCAPE,
  answerKeyGroups,
  bridgeSlashCommands,
  canShowChatView,
  cardKeys,
  commandDelivery,
  composerAgent,
  hasModePicker,
  keysAllowed,
  mergePendingSends,
  ownModelPicker
} from '../chat/terminalChatBridge'

describe('Cursor in the terminal chat view', () => {
  it('a Cursor pane Tessel started on this computer has the chat view', () => {
    expect(CHAT_VIEW_AGENTS).toContain('cursor')
    expect(canShowChatView({ kind: 'agent', agentId: 'cursor' })).toBe(true)
    expect(canShowChatView({ kind: 'agent', agentId: 'cursor', detected: true })).toBe(false)
    expect(canShowChatView({ kind: 'agent', agentId: 'cursor', remoteHostId: 'ssh-1' })).toBe(false)
  })

  it('has its own composer agent, commands typed key by key, its own model picker and no mode picker', () => {
    expect(composerAgent('cursor')).toBe('cursor')
    expect(composerAgent('openclaude')).toBe('claude')
    expect(commandDelivery('cursor', '/model')).toBe('type')
    expect(commandDelivery('cursor', 'hello')).toBe(null)
    expect(commandDelivery('claude', '/compact')).toBe('paste')
    expect(ownModelPicker('cursor')).toBe(true)
    expect(ownModelPicker('codex')).toBe(true)
    expect(ownModelPicker('claude')).toBe(false)
    expect(hasModePicker('cursor')).toBe(false)
    for (const a of ['claude', 'openclaude', 'codex']) expect(hasModePicker(a)).toBe(true)
  })

  it("lists Cursor's own slash commands, model first", () => {
    const names = bridgeSlashCommands('cursor', { options: ['model', 'effort'] }).map((c) => c.name)
    expect(names[0]).toBe('model')
    for (const n of ['plan', 'ask', 'clear', 'resume', 'summarize', 'help']) expect(names).toContain(n)
    expect(names).not.toContain('compact')
    expect(names).not.toContain('effort')
    expect(bridgeSlashCommands('cursor').every((c) => c.kind === 'command' && c.description)).toBe(true)
  })

  it('Stop and Deny are Ctrl+C, Allow is "y" (Escape and "1" for the others)', () => {
    expect(cardKeys('cursor')).toEqual({ stop: '\x03', allow: 'y', deny: '\x03' })
    expect(KEY_CTRL_C).toBe('\x03')
    for (const a of ['claude', 'openclaude', 'codex']) expect(cardKeys(a)).toEqual({ stop: KEY_ESCAPE, allow: KEY_ALLOW, deny: KEY_ESCAPE })
  })

  it('never two Ctrl+C within the gap (Cursor quits on a second one within 2 s)', () => {
    expect(INTERRUPT_GAP_MS).toBeGreaterThan(2000)
    expect(keysAllowed(KEY_CTRL_C, null, 1000)).toBe(true)
    expect(keysAllowed(KEY_CTRL_C, 1000, 1000 + INTERRUPT_GAP_MS - 1)).toBe(false)
    expect(keysAllowed(KEY_CTRL_C, 1000, 1000 + INTERRUPT_GAP_MS)).toBe(true)
    // Other keys are never held back.
    expect(keysAllowed('y', 1000, 1001)).toBe(true)
    expect(keysAllowed(KEY_ESCAPE, 1000, 1001)).toBe(true)
  })

  it("a sent message stays shown until a prompt after the file's earlier ones has it (Cursor's file has no times)", () => {
    const old = [{ type: 'user', id: 'u0', text: 'same words' }]
    const pending = [{ id: 1, text: 'same words', at: 5000, delivered: true, seen: 1 }]
    // Only the earlier prompt: not taken for the new one, even delivered.
    let res = mergePendingSends(old, pending)
    expect(res.done).toEqual([])
    expect(res.events.at(-1)).toMatchObject({ type: 'user', text: 'same words', status: 'sent' })
    res = mergePendingSends([...old, { type: 'user', id: 'u1', text: 'same words' }], pending)
    expect(res.done).toEqual([1])
    expect(res.events).toHaveLength(2)
  })

  it('no question card keys for Cursor (its questions are answered in its terminal)', () => {
    const prompt = { questions: [{ question: 'Pick', options: [{ label: 'A' }, { label: 'B' }] }] }
    expect(answerKeyGroups('cursor', prompt, [['A']])).toEqual([])
  })
})
