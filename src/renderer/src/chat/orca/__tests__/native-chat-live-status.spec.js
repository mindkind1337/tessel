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
import { describe, expect, it } from 'vitest';
import { mergeNativeChatLiveSession } from "../native-chat-live-status.js";
import { selectNativeChatViewState } from "../native-chat-view-state.js";
import { shouldShowNativeChatWorking } from "../native-chat-working-suppression.js";
function assistant(id, text) {
    return {
        id,
        role: 'assistant',
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp: 2,
        source: 'transcript'
    };
}
function user(id, text) {
    return {
        id,
        role: 'user',
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp: 1,
        source: 'transcript'
    };
}
describe('mergeNativeChatLiveSession', ()=>{
    it("surfaces live 'working' before the assistant turn lands in the transcript", ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'do a thing')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working'
        });
        expect(session.status).toBe('working');
        expect(session.messages).toHaveLength(1);
    });
    it("keeps 'working' authoritative when a prior assistant message is present", ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'do a thing'),
                assistant('a-1', 'done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working'
        });
        expect(session.status).toBe('working');
    });
    it('does not treat assistant prose as turn completion while lifecycle is mid-generation', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'go'),
                assistant('a-1', 'done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 1,
            transcriptLifecycle: {
                state: 'working',
                turnId: 'u-1',
                timestamp: 1
            }
        });
        expect(session.status).toBe('working');
    });
    it('recovers via assistant prose when capable host has no in-progress lifecycle', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'go'),
                assistant('a-1', 'done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 1
        });
        expect(session.status).toBe('ready');
    });
    it('settles a dropped working hook from an explicit completion marker', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'go'),
                assistant('a-1', 'done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 1,
            transcriptLifecycle: {
                state: 'completed',
                turnId: 'turn-1',
                timestamp: 2
            }
        });
        expect(session.status).toBe('ready');
    });
    it('settles a dropped working hook from an explicit interruption marker', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'go')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 1,
            transcriptLifecycle: {
                state: 'interrupted',
                turnId: 'turn-1',
                timestamp: 2
            }
        });
        expect(session.status).toBe('ready');
    });
    it('does not apply an older completion marker to a newer working turn', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'prior')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 5,
            transcriptLifecycle: {
                state: 'completed',
                turnId: 'turn-1',
                timestamp: 2
            }
        });
        expect(session.status).toBe('working');
    });
    it('does not apply an older interruption marker to a newer working turn', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'prior')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 5,
            transcriptLifecycle: {
                state: 'interrupted',
                turnId: 'turn-1',
                timestamp: 2
            }
        });
        expect(session.status).toBe('working');
    });
    it('settles an unorderable (null-timestamp) completion marker for live work', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'prior')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 5,
            transcriptLifecycle: {
                state: 'completed',
                turnId: 'turn-1',
                timestamp: null
            }
        });
        expect(session.status).toBe('ready');
    });
    it('settles a completion slightly before hook receipt within clock-skew slack', ()=>{
        const hookStartedAt = 1_700_000_000_000;
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: hookStartedAt,
            transcriptLifecycle: {
                state: 'completed',
                turnId: 'turn-1',
                timestamp: hookStartedAt - 500
            }
        });
        expect(session.status).toBe('ready');
    });
    it('preserves the assistant fallback when the serving host lacks explicit boundaries', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'done')
            ],
            sessionId: 'sess',
            agent: 'grok',
            hookState: 'working',
            stateStartedAt: 1
        });
        expect(session.status).toBe('ready');
    });
    it('keeps working while the hook reports a live background child', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'lead done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 1,
            transcriptLifecycle: {
                state: 'completed',
                turnId: 'turn-1',
                timestamp: 2
            },
            hookHasWorkingSubagents: true
        });
        expect(session.status).toBe('working');
    });
    it('settles on an interruption even while the hook reports a live background child', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                assistant('a-1', 'lead done')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            stateStartedAt: 1,
            transcriptLifecycle: {
                state: 'interrupted',
                turnId: 'turn-1',
                timestamp: 2
            },
            hookHasWorkingSubagents: true
        });
        expect(session.status).toBe('ready');
    });
    it('leaves completed states (done/waiting/blocked) on the derived status', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'hi')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'done'
        });
        expect(session.status).toBe('ready');
    });
    it('surfaces live work while the transcript loads and honors errors outright', ()=>{
        expect(mergeNativeChatLiveSession({
            messages: [],
            sessionId: null,
            agent: 'claude',
            hookState: 'working',
            loading: true
        }).status).toBe('working');
        expect(mergeNativeChatLiveSession({
            messages: [],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            loading: true
        }).status).toBe('working');
        expect(mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'run it')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            loading: true
        }).status).toBe('working');
        const errored = mergeNativeChatLiveSession({
            messages: [],
            sessionId: 'sess',
            agent: 'claude',
            hookState: null,
            error: 'unreadable'
        });
        expect(errored.status).toBe('error');
        expect(errored.error).toBe('unreadable');
    });
    it('assembles an empty transcript with no live work as empty', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [],
            sessionId: 'sess',
            agent: 'claude',
            hookState: null
        });
        expect(session.status).toBe('empty');
    });
    it('keeps the Stop affordance for a working known session mid-flush', ()=>{
        const session = mergeNativeChatLiveSession({
            messages: [
                user('u-1', 'run it')
            ],
            sessionId: 'sess',
            agent: 'claude',
            hookState: 'working',
            loading: true
        });
        const viewState = selectNativeChatViewState(session);
        const isConversation = viewState.kind === 'ready';
        expect(viewState).toEqual({
            kind: 'ready',
            isWorking: true
        });
        expect(shouldShowNativeChatWorking({
            isConversation,
            working: session.status === 'working',
            interrupted: false
        })).toBe(true);
    });
});
