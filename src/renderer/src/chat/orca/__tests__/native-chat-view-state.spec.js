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
import { describe, it, expect } from 'vitest';
import { selectNativeChatViewState } from "../native-chat-view-state.js";
const message = {
    id: 'a',
    role: 'assistant',
    blocks: [
        {
            type: 'text',
            text: 'hi'
        }
    ],
    timestamp: 1,
    source: 'transcript'
};
function session(overrides) {
    return {
        messages: [
            message
        ],
        status: 'ready',
        sessionId: 'sess',
        agent: 'claude',
        ...overrides
    };
}
describe('selectNativeChatViewState', ()=>{
    it('maps loading', ()=>{
        expect(selectNativeChatViewState(session({
            messages: [],
            status: 'loading'
        })).kind).toBe('loading');
    });
    it('keeps rendering messages while the session reports loading', ()=>{
        expect(selectNativeChatViewState(session({
            status: 'loading'
        }))).toEqual({
            kind: 'ready',
            isWorking: false
        });
    });
    it('maps error with its message', ()=>{
        const state = selectNativeChatViewState(session({
            status: 'error',
            error: 'boom'
        }));
        expect(state).toEqual({
            kind: 'error',
            message: 'boom'
        });
    });
    it('maps empty when there are no messages', ()=>{
        expect(selectNativeChatViewState(session({
            messages: [],
            status: 'ready'
        })).kind).toBe('empty');
    });
    it('empty wins over a working hook on a pre-session conversation', ()=>{
        expect(selectNativeChatViewState(session({
            messages: [],
            status: 'working',
            sessionId: null
        })).kind).toBe('empty');
    });
    it('holds loading for a known session working before its transcript flushes', ()=>{
        expect(selectNativeChatViewState(session({
            messages: [],
            status: 'working'
        })).kind).toBe('loading');
    });
    it('keeps working status for a known session so the composer can offer Stop', ()=>{
        expect(selectNativeChatViewState(session({
            status: 'working'
        }))).toEqual({
            kind: 'ready',
            isWorking: true
        });
    });
    it('maps ready (not working)', ()=>{
        expect(selectNativeChatViewState(session({
            status: 'ready'
        }))).toEqual({
            kind: 'ready',
            isWorking: false
        });
    });
    it('maps ready working when the agent is mid-turn', ()=>{
        expect(selectNativeChatViewState(session({
            status: 'working'
        }))).toEqual({
            kind: 'ready',
            isWorking: true
        });
    });
});
