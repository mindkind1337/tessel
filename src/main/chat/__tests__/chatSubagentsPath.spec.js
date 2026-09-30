// @vitest-environment node
// The whole path of a Claude chat's sub-agents and context facts, from the
// CLI's stream-json frames to what the chat pane reads: claudeFrames
// normalizes them, the session manager journals and sends them ('chat:event'),
// the pane's journal adapter turns them into the header's list (meta.subagents),
// the transcript's rows and the context ring's facts. Synthetic frames in the
// recorded shapes (subagents.spec.js, claude-real-frames.jsonl); no agent runs.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { createChatSessions } from '../sessions'
import { createFrameState, normalizeFrame } from '../claudeFrames.js'
import { createJournalAdapter } from '../../../renderer/src/chat/orca/adapter/journalAdapter.js'
import { selectStructuredAgentContextUsage } from '../../../renderer/src/chat/orca/shared/structured-agent-session-context-usage.js'

const flush = () => new Promise((r) => setImmediate(r))

// A Claude adapter that plays frames through the real normalizer (as claudeChat.js does).
class FrameAdapter extends EventEmitter {
  constructor(clock) {
    super()
    this.frames = createFrameState({ now: () => clock.t })
    this.start = vi.fn(async () => ({ ok: true, pid: 1, info: {} }))
    this.send = vi.fn(async () => ({ ok: true }))
    this.interrupt = vi.fn(async () => ({ ok: true }))
    this.setModel = vi.fn(async () => ({ ok: true }))
    this.setEffort = vi.fn(async () => ({ ok: true }))
    this.setPermissionMode = vi.fn(async () => ({ ok: true }))
    this.close = vi.fn(async () => this.emit('exit', { code: 0, signal: null, stderrTail: '', crashed: false }))
  }
  play(frame) {
    for (const ev of normalizeFrame(frame, this.frames)) {
      const { type, ...payload } = ev
      this.emit(type, payload)
    }
  }
}

let tmp, sent, adapter
const paneId = 'pane-sub'
const clock = { t: 1000 }

beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-chat-subpath-'))
  sent = []
  clock.t = 1000
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function chatSessions() {
  return createChatSessions({
    dir: tmp,
    send: (channel, payload) => sent.push({ channel, ...payload }),
    createAdapter: () => (adapter = new FrameAdapter(clock)),
    resolveClaude: async () => ({ exe: 'C:\\bin\\claude.exe', exeArgs: [] }),
    env: { forPane: () => ({ Path: 'C:\\Windows' }) },
    team: { newSecret: () => 'f'.repeat(64), setSecret: () => {}, revokeSecret: () => {} },
    trust: { isTrusted: () => true, ask: async () => true, trust: () => true }
  })
}

// The pane's side: every 'chat:event' through the adapter, like useStructuredAgentSession.
function paneOf() {
  const pane = createJournalAdapter({ now: () => clock.t })
  for (const msg of sent) if (msg.channel === 'chat:event' && msg.paneId === paneId) pane.apply(msg.event)
  return pane
}

const task = {
  type: 'assistant',
  message: {
    id: 'parent-message',
    model: 'claude-haiku-4-5-20251001',
    usage: { input_tokens: 10, cache_creation_input_tokens: 7881, cache_read_input_tokens: 18737, output_tokens: 4 },
    content: [{ type: 'tool_use', id: 'task-tool', name: 'Agent', input: { description: 'Inspect fixtures', subagent_type: 'Explore', model: 'haiku' } }]
  }
}
const childMessage = {
  type: 'assistant',
  parent_tool_use_id: 'task-tool',
  message: { id: 'child-message', model: 'haiku', usage: { input_tokens: 10, output_tokens: 2 }, content: [{ type: 'text', text: 'Reading' }] }
}
const childEnd = { type: 'result', parent_tool_use_id: 'task-tool', subtype: 'success', usage: { input_tokens: 10, output_tokens: 5 }, duration_ms: 450 }
const rootEnd = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'Done',
  modelUsage: { 'claude-haiku-4-5-20251001': { contextWindow: 200000, canonicalModel: 'claude-haiku-4-5' } }
}

describe('Claude chat: sub-agents and context reach the pane', () => {
  it('a running sub-agent is in the header list, then done; its text stays apart from the answer', async () => {
    const chat = chatSessions()
    expect((await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).ok).toBe(true)
    await flush()
    chat.send({ paneId, text: 'inspect' })
    adapter.play({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    adapter.play(task)
    adapter.play(childMessage)

    let pane = paneOf()
    expect(Object.values(pane.meta.subagents)).toEqual([
      expect.objectContaining({ id: 'task-tool', title: 'Inspect fixtures', type: 'Explore', model: 'haiku', state: 'running', startedAt: 1000 })
    ])
    // The transcript's roster row, and the child's text keyed apart from the parent's.
    const items = pane.items()
    expect(items.find((i) => i.itemId.startsWith('subagents:')).body.blocks[1]).toMatchObject({ type: 'subagent-group', agents: [{ id: 'task-tool', state: 'working' }] })
    expect(items.find((i) => i.itemId === 'child:task-tool:child-message')).toMatchObject({ agentId: 'task-tool' })

    clock.t = 1500
    adapter.play(childEnd)
    adapter.play(rootEnd)
    pane = paneOf()
    expect(pane.meta.subagents['task-tool']).toMatchObject({ state: 'done', endedAt: 1500, tokens: 15 })

    // The context ring's facts: the parent's last response in haiku's window.
    const usage = selectStructuredAgentContextUsage(pane.items(), null)
    expect(usage).toMatchObject({ usedTokens: 26628, windowTokens: 200000, percentage: 13, estimated: true })
  })

  it('a compaction: its row, and the ring no longer claims a usage', async () => {
    const chat = chatSessions()
    expect((await chat.open({ paneId, cwd: tmp, permissions: 'manual' })).ok).toBe(true)
    await flush()
    chat.send({ paneId, text: 'go' })
    adapter.play({ type: 'system', subtype: 'session_state_changed', state: 'running' })
    adapter.play(task)
    adapter.play(rootEnd)
    expect(selectStructuredAgentContextUsage(paneOf().items(), null)).not.toBeNull()
    adapter.play({ type: 'system', subtype: 'compact_boundary', compact_metadata: { trigger: 'manual', pre_tokens: 26628 } })
    const pane = paneOf()
    expect(pane.items().find((i) => i.body.presentation === 'compaction')).toBeTruthy()
    expect(selectStructuredAgentContextUsage(pane.items(), null)).toBeNull()
  })
})
