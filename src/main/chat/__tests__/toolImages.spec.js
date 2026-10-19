// @vitest-environment node
// Images tools gave back and images kept in transcripts, for every agent
// (historyAttachments.js "Resolution" contract): the history and chat view
// readers, the live chat frames, the journal and the conversation's caps.
// Synthetic transcripts and bytes only.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EventEmitter } from 'events'
import fs from 'fs'
import os from 'os'
import { join } from 'path'
import { pathToFileURL } from 'url'
import { claudeHistoryEvents, codexHistoryEvents, opencodeHistoryEvents, resolveHistoryAttachments, ATTACHMENT_LIMITS, HISTORY_LIMITS } from '../transcriptHistory'
import { cursorViewEvents, antigravityViewEvents } from '../transcriptView'
import { imageFromBase64, imageFromPath, liveImages, noteAttachments, resolveHistoryAttachmentsCached } from '../historyAttachments'
import { createFrameState, normalizeFrame } from '../claudeFrames'
import { createCodexState, normalizeCodexNotification } from '../codexChat'
import { createChatJournal, IMAGE_KEEP_BYTES } from '../journal'
import { createChatSessions, LIVE_IMAGE_LIMITS } from '../sessions'
import { PNG_1x1, TEXT, jpegOf, pngOf } from './fixtures/chatImageBytes'

const CODEX_ID = '01946a2b-c3d4-7e5f-8a9b-0c1d2e3f4a5b'
const ts = (s) => `2026-09-01T10:00:${String(s).padStart(2, '0')}.000Z`
const b64 = (buf) => buf.toString('base64')
const dataUrl = (buf, type = 'image/png') => `data:${type};base64,${b64(buf)}`
const JPEG = jpegOf(3, 2)
const PNG2 = pngOf(2, 2, 20)
const WITH = { ...HISTORY_LIMITS, attachments: ATTACHMENT_LIMITS }
const of = (events, type) => events.filter((e) => e.type === type)
const json = (records) => records.map((r) => JSON.stringify(r))
const shown = (name, mediaType, url, source) => ({ key: expect.stringMatching(/^[0-9a-f]{24}$/), name, source, mime: mediaType, mediaType, bytes: Buffer.from(url.split(',')[1], 'base64').length, dataUrl: url })

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(join(os.tmpdir(), 'tessel-tool-images-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))
const write = (name, buf) => {
  const file = join(tmp, name)
  fs.writeFileSync(file, buf)
  return file
}

// ---- Claude Code ------------------------------------------------------------------
const claudeImg = (buf, media_type = 'image/png') => ({ type: 'image', source: { type: 'base64', media_type, data: b64(buf) } })
const claudeCall = (s, id, name, input) => ({ type: 'assistant', uuid: `a${s}`, timestamp: ts(s), message: { id: `m${s}`, role: 'assistant', content: [{ type: 'tool_use', id, name, input }] } })
const claudeResult = (s, id, content, extra = {}) => ({ type: 'user', uuid: `r${s}`, timestamp: ts(s), message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] }, ...extra })

describe('Claude Code: tool result images', () => {
  it('a tool result\'s image blocks are on its result (source tool); its text is unchanged', () => {
    const events = claudeHistoryEvents(
      json([
        { type: 'user', uuid: 'u1', timestamp: ts(0), message: { role: 'user', content: 'take a screenshot' } },
        claudeCall(1, 't1', 'mcp__browser__screenshot', {}),
        claudeResult(2, 't1', [{ type: 'text', text: 'Saved.' }, claudeImg(PNG_1x1), claudeImg(TEXT)])
      ]),
      WITH
    )
    resolveHistoryAttachments(events)
    const [r] = of(events, 'toolResult')
    expect(r.images).toEqual([shown('image.png', 'image/png', dataUrl(PNG_1x1), 'tool')])
    expect(r.imagesMore).toBe(1)
    expect(r.text).toBe('Saved.')
  })

  it('toolUseResult.file.base64 is used only when the content has no image (never twice)', () => {
    const lines = json([
      claudeCall(1, 't1', 'Read', { file_path: 'C:\\x\\a.png' }),
      claudeResult(2, 't1', [claudeImg(PNG_1x1)], { toolUseResult: { type: 'image', file: { base64: b64(PNG_1x1), type: 'image/png' } } }),
      claudeCall(3, 't2', 'Read', { file_path: 'C:\\x\\b.jpg' }),
      claudeResult(4, 't2', 'read', { toolUseResult: { type: 'image', file: { base64: b64(JPEG), type: 'image/jpeg' } } })
    ])
    const events = claudeHistoryEvents(lines, WITH)
    resolveHistoryAttachments(events)
    const [one, two] = of(events, 'toolResult')
    expect(one.images).toHaveLength(1)
    expect(two.images).toEqual([shown('image.jpg', 'image/jpeg', dataUrl(JPEG, 'image/jpeg'), 'tool')])
  })

  it('a pasted "[Image #N]" shows the transcript\'s bytes (source pasted), its file in %TEMP% long gone', () => {
    const events = claudeHistoryEvents(
      json([
        { type: 'user', uuid: 'u1', timestamp: ts(0), imagePasteIds: [1], message: { role: 'user', content: [{ type: 'text', text: '[Image #1] what is this?' }, claudeImg(PNG_1x1)] } },
        // Claude Code's own note naming the pasted file: meta, not shown.
        { type: 'user', uuid: 'u2', timestamp: ts(1), isMeta: true, message: { role: 'user', content: [{ type: 'text', text: `[Image: source: ${join(tmp, 'gone.png')}]` }] } }
      ]),
      WITH
    )
    resolveHistoryAttachments(events)
    const users = of(events, 'user')
    expect(users).toHaveLength(1)
    expect(users[0].images).toEqual([shown('image.png', 'image/png', dataUrl(PNG_1x1), 'pasted')])
    expect(users[0].text).toBe('[Image #1] what is this?')
  })

  it('without attachment caps (the search index) nothing is decoded', () => {
    const events = claudeHistoryEvents(json([claudeCall(1, 't1', 'Read', {}), claudeResult(2, 't1', [claudeImg(PNG_1x1)])]))
    expect(of(events, 'toolResult')[0].images).toBeUndefined()
  })
})

// ---- Codex ------------------------------------------------------------------------
const codexLine = (s, type, payload) => ({ timestamp: ts(s), type, payload })
const codexItem = (s, item, turn = 'turn-1') => codexLine(s, 'event_msg', { type: 'item_completed', thread_id: CODEX_ID, turn_id: turn, item })

describe('Codex: tool and pasted images', () => {
  it('a code cell\'s output input_image items are its result\'s images; an MCP image inside it is not shown twice', () => {
    const events = codexHistoryEvents(
      json([
        codexLine(1, 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'await screenshot()' }),
        codexItem(2, { type: 'McpToolCall', id: 'mcp-1', server: 'browser', tool: 'screenshot', result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: b64(PNG_1x1), mimeType: 'image/png' }] } }),
        codexLine(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'done' }, { type: 'input_image', image_url: dataUrl(PNG_1x1), detail: 'auto' }] })
      ]),
      CODEX_ID,
      WITH
    )
    resolveHistoryAttachments(events)
    const results = of(events, 'toolResult')
    expect(results).toHaveLength(1)
    expect(results[0].text).toBe('done')
    expect(results[0].images).toEqual([shown('image.png', 'image/png', dataUrl(PNG_1x1), 'tool')])
  })

  it('view_image (ImageView, a file: URL): its file on the running cell; a gone file is listed missing; alone, a call of its own', () => {
    const shot = write('shot.png', PNG2)
    const gone = join(tmp, 'gone.png')
    const events = codexHistoryEvents(
      json([
        codexLine(1, 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'view' }),
        codexItem(2, { type: 'ImageView', id: 'v1', path: pathToFileURL(gone).href }),
        codexLine(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'viewed' }] }),
        codexItem(4, { type: 'ImageView', id: 'v2', path: pathToFileURL(shot).href })
      ]),
      CODEX_ID,
      WITH
    )
    resolveHistoryAttachments(events)
    const [cell, own] = of(events, 'toolResult')
    expect(cell.images).toEqual([{ source: 'tool', name: 'gone.png', mime: 'image/png', path: gone, missing: true }])
    expect(of(events, 'tool').find((e) => e.id === 'v2')).toMatchObject({ name: 'view_image', input: { path: shot } })
    expect(own.images).toEqual([shown('shot.png', 'image/png', dataUrl(PNG2), 'tool')])
  })

  it('the cell already shows the image inline: view_image\'s copy is left out', () => {
    const events = codexHistoryEvents(
      json([
        codexLine(1, 'response_item', { type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'view' }),
        codexItem(2, { type: 'ImageView', id: 'v1', path: pathToFileURL(join(tmp, 'gone.png')).href }),
        codexLine(3, 'response_item', { type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_image', image_url: dataUrl(JPEG, 'image/jpeg') }] })
      ]),
      CODEX_ID,
      WITH
    )
    resolveHistoryAttachments(events)
    expect(of(events, 'toolResult')[0].images).toEqual([shown('image.jpg', 'image/jpeg', dataUrl(JPEG, 'image/jpeg'), 'tool')])
  })

  it('a generated image (image_gen): its bytes, named as the file Codex saved', () => {
    const saved = join(tmp, 'generated_images', 'ig_1.png')
    const events = codexHistoryEvents(json([codexItem(1, { type: 'Extension', kind: 'image_gen.generation', id: 'ig_1', status: 'completed', revisedPrompt: 'a cat', result: b64(PNG_1x1), savedPath: saved })]), CODEX_ID, WITH)
    resolveHistoryAttachments(events)
    expect(of(events, 'tool')[0]).toMatchObject({ name: 'image_gen', input: { prompt: 'a cat' } })
    expect(of(events, 'toolResult')[0].images).toEqual([shown('ig_1.png', 'image/png', dataUrl(PNG_1x1), 'tool')])
  })

  it('a pasted image (local_image) whose file is gone: the data: URL the turn sent the model', () => {
    const gone = join(tmp, 'codex-clipboard-1.png')
    const kept = write('codex-clipboard-2.png', PNG2)
    const events = codexHistoryEvents(
      json([
        codexLine(1, 'response_item', { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: dataUrl(PNG_1x1) }], internal_chat_message_metadata_passthrough: { turn_id: 'turn-1' } }),
        codexItem(2, { type: 'UserMessage', id: 'um1', content: [{ type: 'text', text: 'see' }, { type: 'local_image', path: gone }] }),
        codexItem(3, { type: 'AgentMessage', id: 'am1', content: [{ type: 'Text', text: 'a dot' }] }),
        codexItem(4, { type: 'UserMessage', id: 'um2', content: [{ type: 'text', text: 'and' }, { type: 'local_image', path: kept }] }, 'turn-2'),
        codexItem(5, { type: 'UserMessage', id: 'um3', content: [{ type: 'text', text: 'lost' }, { type: 'local_image', path: gone }] }, 'turn-3')
      ]),
      CODEX_ID,
      WITH
    )
    resolveHistoryAttachments(events)
    const [a, b, c] = of(events, 'user')
    expect(a.images).toEqual([shown('codex-clipboard-1.png', 'image/png', dataUrl(PNG_1x1), 'pasted')])
    expect(b.images).toEqual([shown('codex-clipboard-2.png', 'image/png', dataUrl(PNG2), 'pasted')])
    expect(c.images).toEqual([{ source: 'pasted', name: 'codex-clipboard-1.png', mime: 'image/png', path: gone, missing: true }])
    expect(c.text).toBe('lost')
  })
})

// ---- Cursor, Antigravity, OpenCode -------------------------------------------------
describe('Cursor, Antigravity and OpenCode images', () => {
  it('Cursor: the files <image_files> lists (mixed slashes), a gone one listed missing', () => {
    fs.mkdirSync(join(tmp, 'assets'))
    const there = write(join('assets', 'shot.png'), PNG_1x1)
    const mixed = `${tmp}/assets/shot.png`
    const gone = `${tmp}/assets/gone.png`
    const text = `[Image]\n[Image]\n<image_files>\nThe following images were provided by the user:\n1. ${mixed}\n2. ${gone}\n\nNote: these images are attached.\n</image_files>\n<user_query>\nwhat is it?\n</user_query>`
    const events = cursorViewEvents(json([{ role: 'user', message: { content: [{ type: 'text', text }] } }]), WITH)
    resolveHistoryAttachments(events)
    const [u] = of(events, 'user')
    expect(u.text).toBe('what is it?')
    expect(u.images[0]).toEqual(shown('shot.png', 'image/png', dataUrl(PNG_1x1), 'user'))
    expect(u.images[1]).toMatchObject({ source: 'user', name: 'gone.png', missing: true })
    expect(fs.existsSync(there)).toBe(true)
  })

  it('Cursor: no paths listed, one "[image]" per "[Image]" line as before', () => {
    const events = cursorViewEvents(json([{ role: 'user', message: { content: [{ type: 'text', text: '[Image]\n<image_files>\n</image_files>\n<user_query>\nhi\n</user_query>' }] } }]), WITH)
    resolveHistoryAttachments(events)
    expect(of(events, 'user')[0].text).toBe('hi\n[image]')
  })

  it('Antigravity: media[] of the step that answers a call are its result\'s images; a prompt\'s are the prompt\'s', () => {
    const shot = write('media_1.png', PNG_1x1)
    const pasted = write('media_2.png', PNG2)
    const events = antigravityViewEvents(
      json([
        { step_index: 0, source: 'USER_EXPLICIT', type: 'USER_INPUT', status: 'DONE', created_at: ts(0), content: '<USER_REQUEST>look</USER_REQUEST>', media: [{ mime_type: 'image/png', uri: pasted.replace(/\\/g, '/') }] },
        { step_index: 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', created_at: ts(1), tool_calls: [{ name: 'view_file', args: { AbsolutePath: shot } }] },
        { step_index: 2, source: 'MODEL', type: 'GENERIC', status: 'DONE', created_at: ts(2), content: 'viewed', media: [{ mime_type: 'image/png', uri: shot.replace(/\\/g, '/') }, { mime_type: 'video/mp4', uri: join(tmp, 'x.mp4') }] }
      ]),
      WITH
    )
    resolveHistoryAttachments(events)
    expect(of(events, 'user')[0].images).toEqual([shown('media_2.png', 'image/png', dataUrl(PNG2), 'user')])
    expect(of(events, 'toolResult')[0].images).toEqual([shown('media_1.png', 'image/png', dataUrl(PNG_1x1), 'tool')])
  })

  it('OpenCode: a tool\'s image attachments (file parts) are its result\'s images', () => {
    const events = opencodeHistoryEvents(
      [
        { info: { id: 'msg_1', role: 'user', time: { created: 1 } }, parts: [{ type: 'text', text: 'read it' }] },
        {
          info: { id: 'msg_2', role: 'assistant', time: { created: 2 } },
          parts: [{ type: 'tool', callID: 'call_1', tool: 'read', state: { status: 'completed', input: { filePath: 'a.png' }, output: 'Image read', attachments: [{ type: 'file', mime: 'image/png', filename: 'a.png', url: dataUrl(PNG_1x1) }, { type: 'file', mime: 'text/plain', url: 'data:text/plain;base64,aGk=' }], time: { start: 2, end: 3 } } }]
        }
      ],
      WITH
    )
    resolveHistoryAttachments(events)
    expect(of(events, 'toolResult')[0].images).toEqual([shown('a.png', 'image/png', dataUrl(PNG_1x1), 'tool')])
  })
})

// ---- Caps, SSH hosts ---------------------------------------------------------------
describe('caps and SSH hosts', () => {
  it('at most 4 images an entry and `pageImages` a page, newest first: the rest counted in imagesMore', () => {
    const events = []
    for (let i = 0; i < 3; i++) events.push(noteAttachments({ type: 'toolResult', id: `t${i}`, text: '' }, Array.from({ length: 6 }, (_, k) => imageFromBase64(b64(pngOf(1, 1, i * 10 + k)), 'image/png', undefined, 'tool'))))
    resolveHistoryAttachments(events, { ...ATTACHMENT_LIMITS, pageImages: 6 })
    expect(events.map((e) => (e.images || []).length)).toEqual([0, 2, 4])
    expect(events.map((e) => e.imagesMore)).toEqual([6, 4, 2])
    // A tool's output text never gets "[image]".
    expect(events.every((e) => e.text === '')).toBe(true)
  })

  it('a host\'s transcript: its paths are listed as remote, never read here; its inline images show', async () => {
    const local = write('here.png', PNG_1x1)
    const sync = [noteAttachments({ type: 'toolResult', id: 't1', text: '' }, [imageFromPath('/home/me/shot.png', undefined, 'tool'), imageFromBase64(b64(PNG2), 'image/png', undefined, 'tool')])]
    resolveHistoryAttachments(sync, ATTACHMENT_LIMITS, { local: false })
    expect(sync[0].images).toEqual([{ source: 'tool', name: 'shot.png', mime: 'image/png', path: expect.stringMatching(/shot\.png$/), remote: true }, shown('image.png', 'image/png', dataUrl(PNG2), 'tool')])
    const asked = []
    const cached = [noteAttachments({ type: 'user', id: 'u1', text: 'look' }, [imageFromPath(local)])]
    await resolveHistoryAttachmentsCached(cached, ATTACHMENT_LIMITS, { host: true, isRemote: async (p) => (asked.push(p), true) })
    expect(cached[0].images).toEqual([{ source: 'user', name: 'here.png', mime: 'image/png', path: local, remote: true }])
    expect(asked).toEqual([])
    expect(cached[0].text).toBe('look')
  })

  it('the chat view: a gone file is listed missing, from its cache-less check', async () => {
    const gone = join(tmp, 'gone.png')
    const evs = [noteAttachments({ type: 'toolResult', id: 't1', text: '' }, [imageFromPath(gone, undefined, 'tool')])]
    await resolveHistoryAttachmentsCached(evs, ATTACHMENT_LIMITS, { isRemote: async () => false })
    expect(evs[0].images).toEqual([{ source: 'tool', name: 'gone.png', mime: 'image/png', path: gone, missing: true }])
  })
})

// ---- Live chat frames ---------------------------------------------------------------
describe('live chat: tool result images', () => {
  it('Claude: image blocks go on the toolResult event, not "[image]" in its text', () => {
    const out = normalizeFrame(
      { type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'shot' }, claudeImg(PNG_1x1), claudeImg(TEXT), { type: 'image', source: { type: 'url', url: 'https://example.invalid/a.png' } }] }] } },
      createFrameState()
    )
    expect(out).toEqual([{ type: 'toolResult', toolUseId: 't1', isError: false, text: 'shot', images: [shown('image.png', 'image/png', dataUrl(PNG_1x1), 'tool')], imagesMore: 2, parentToolUseId: null }])
  })

  it('liveImages: 4 an entry, the same image once, a path listed (remote for a host)', () => {
    const items = [{ base64: b64(PNG_1x1), mediaType: 'image/png' }, { dataUrl: dataUrl(PNG_1x1) }, { path: '/srv/x.png', remote: true }, { base64: b64(PNG2) }, { base64: b64(JPEG) }, { base64: b64(pngOf(1, 1, 3)) }]
    const r = liveImages(items)
    expect(r.images.map((i) => i.path || i.mime)).toEqual(['image/png', '/srv/x.png', 'image/png', 'image/jpeg'])
    expect(r.images[1]).toEqual({ source: 'tool', name: 'x.png', mime: 'image/png', path: '/srv/x.png', remote: true })
    expect(r.imagesMore).toBe(1)
    // A relative path names no file: counted, not listed.
    expect(liveImages([{ path: 'relative.png' }])).toEqual({ imagesMore: 1 })
  })

  it('Codex: an MCP tool\'s image, a dynamic tool\'s inputImage, view_image\'s file (remote on a host)', () => {
    const state = createCodexState({ threadId: 'th' })
    const mcp = normalizeCodexNotification('item/completed', { threadId: 'th', item: { type: 'mcpToolCall', id: 'i1', server: 'b', tool: 'shot', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }, { type: 'image', data: b64(PNG_1x1), mimeType: 'image/png' }] } } }, state)
    expect(mcp.find((e) => e.type === 'toolResult')).toMatchObject({ toolUseId: 'i1', text: 'ok', images: [shown('image.png', 'image/png', dataUrl(PNG_1x1), 'tool')] })
    const dyn = normalizeCodexNotification('item/completed', { threadId: 'th', item: { type: 'dynamicToolCall', id: 'i2', tool: 'x', status: 'completed', contentItems: [{ type: 'inputText', text: 'here' }, { type: 'inputImage', imageUrl: dataUrl(JPEG, 'image/jpeg') }] } }, state)
    expect(dyn.find((e) => e.type === 'toolResult')).toMatchObject({ text: 'here', images: [shown('image.jpg', 'image/jpeg', dataUrl(JPEG, 'image/jpeg'), 'tool')] })
    const file = join(tmp, 'v.png')
    const view = normalizeCodexNotification('item/completed', { threadId: 'th', item: { type: 'imageView', id: 'i3', path: file } }, state)
    expect(view.find((e) => e.type === 'assistant').blocks[0]).toMatchObject({ name: 'ViewImage', input: { path: file } })
    expect(view.find((e) => e.type === 'toolResult').images).toEqual([{ source: 'tool', name: 'v.png', mime: 'image/png', path: file }])
    const remote = createCodexState({ threadId: 'th', remote: true })
    const there = normalizeCodexNotification('item/completed', { threadId: 'th', item: { type: 'imageView', id: 'i4', path: '/home/me/v.png' } }, remote)
    expect(there.find((e) => e.type === 'toolResult').images).toEqual([{ source: 'tool', name: 'v.png', mime: 'image/png', path: '/home/me/v.png', remote: true }])
  })
})

// ---- Journal and the conversation's caps ----------------------------------------------
describe('journal and conversation caps', () => {
  it('the journal keeps a tool result\'s images whole while they fit, else marked missing (never a cut data: URL)', () => {
    const j = createChatJournal({ dir: tmp, paneId: 'p1' })
    const small = liveImages([{ base64: b64(PNG_1x1) }]).images
    const big = liveImages([{ base64: b64(pngOf(4, 4, IMAGE_KEEP_BYTES)) }]).images
    j.append(1, { type: 'toolResult', id: 't1', text: 'x', images: small })
    j.append(2, { type: 'toolResult', id: 't2', text: 'y', images: big })
    const [a, b] = j.read().map((r) => r.event)
    expect(a.images).toEqual(small)
    expect(b.images[0].dataUrl).toBeUndefined()
    expect(b.images[0]).toMatchObject({ key: big[0].key, name: 'image.png', source: 'tool', mime: 'image/png', missing: true })
  })

  it('a conversation sends at most LIVE_IMAGE_LIMITS images live: later ones are counted', async () => {
    class FakeAdapter extends EventEmitter {
      constructor() {
        super()
        this.start = vi.fn(async () => ({ ok: true, pid: 1, info: {} }))
        this.send = vi.fn(async () => ({ ok: true }))
        this.close = vi.fn(async () => this.emit('exit', { code: 0, signal: null, stderrTail: '', crashed: false }))
      }
    }
    const sent = []
    const adapters = []
    const chat = createChatSessions({
      dir: tmp,
      send: (channel, payload) => sent.push(payload),
      createAdapter: () => {
        const a = new FakeAdapter()
        adapters.push(a)
        return a
      },
      resolveClaude: async () => ({ exe: 'C:\\bin\\claude.exe', exeArgs: [] }),
      env: { forPane: () => ({ Path: 'C:\\Windows' }) },
      team: { newSecret: () => 'f'.repeat(64), setSecret: () => {}, revokeSecret: () => {} },
      state: { register: async () => {}, unregister: async () => {}, recordChatEvent: async () => {}, observe: async () => {} },
      trust: { isTrusted: () => true, ask: async () => true, trust: () => true }
    })
    expect((await chat.open({ paneId: 'pane-1', cwd: tmp, permissions: 'manual' })).ok).toBe(true)
    await new Promise((r) => setImmediate(r))
    const img = liveImages([{ base64: b64(PNG_1x1) }]).images[0]
    for (let i = 0; i <= LIVE_IMAGE_LIMITS.images; i++) {
      adapters[0].emit('assistant', { messageId: `m${i}`, blocks: [{ type: 'tool_use', id: `t${i}`, name: 'Read', input: {} }] })
      adapters[0].emit('toolResult', { toolUseId: `t${i}`, text: '', images: [img] })
    }
    const results = sent.map((p) => p.event).filter((e) => e.type === 'toolResult')
    expect(results.filter((e) => e.images).length).toBe(LIVE_IMAGE_LIMITS.images)
    expect(results.at(-1)).toMatchObject({ imagesMore: 1 })
    expect(results.at(-1).images).toBeUndefined()
    await chat.close({ paneId: 'pane-1' })
  })
})
