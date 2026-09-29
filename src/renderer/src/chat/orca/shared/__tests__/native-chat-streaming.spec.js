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
import { deriveNativeChatStreamingText, nativeChatStreamingMessage, NATIVE_CHAT_STREAMING_ID } from "../native-chat-streaming.js";
const assistant = (text)=>({
        id: `a-${text.length}`,
        role: 'assistant',
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp: null,
        source: 'transcript'
    });
const user = (text)=>({
        id: `u-${text.length}`,
        role: 'user',
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp: null,
        source: 'transcript'
    });
describe('deriveNativeChatStreamingText', ()=>{
    it('returns null when not working (stale preview never shows)', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [],
            previewText: 'Hello there',
            working: false
        })).toBeNull();
    });
    it('returns null for empty / whitespace preview', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [],
            previewText: '',
            working: true
        })).toBeNull();
        expect(deriveNativeChatStreamingText({
            messages: [],
            previewText: '   ',
            working: true
        })).toBeNull();
    });
    it('shows the preview while it leads an empty/user-tailed transcript', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [
                user('do the thing')
            ],
            previewText: 'Working on it',
            working: true
        })).toBe('Working on it');
    });
    it('treats an optimistic user echo as the active streaming-turn boundary', ()=>{
        const optimistic = {
            ...user('new prompt'),
            id: 'pending:send-1',
            timestamp: 20,
            source: 'scrape'
        };
        expect(deriveNativeChatStreamingText({
            messages: [
                assistant('A much longer answer from the completed prior turn'),
                optimistic
            ],
            previewText: 'New reply',
            working: true
        })).toBe('New reply');
    });
    it('drops the preview once the real assistant turn contains it (no duplicate)', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [
                assistant('Working on it, here is the full answer.')
            ],
            previewText: 'Working on it',
            working: true
        })).toBeNull();
    });
    it('drops the preview when it is not longer than the last assistant turn (no flicker)', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [
                assistant('Same length text')
            ],
            previewText: 'Same length text',
            working: true
        })).toBeNull();
    });
    it('drops a preview flagged as tool output even when it leads the transcript', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [
                assistant('Partial')
            ],
            previewText: 'Exit code 1\nimport { Foo } from "./foo"\nexport function bar() {}',
            working: true,
            previewIsToolOutput: true
        })).toBeNull();
    });
    it('still shows a leading preview when it is not tool output', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [
                assistant('Partial')
            ],
            previewText: 'Partial answer that is now much longer than before',
            working: true,
            previewIsToolOutput: false
        })).toBe('Partial answer that is now much longer than before');
    });
    it('keeps showing while the preview still leads (grows past the last turn)', ()=>{
        expect(deriveNativeChatStreamingText({
            messages: [
                assistant('Partial')
            ],
            previewText: 'Partial answer that is now much longer than before',
            working: true
        })).toBe('Partial answer that is now much longer than before');
    });
});
describe('nativeChatStreamingMessage', ()=>{
    it('builds a stable-id assistant hook message', ()=>{
        const m = nativeChatStreamingMessage('hi');
        expect(m.id).toBe(NATIVE_CHAT_STREAMING_ID);
        expect(m.role).toBe('assistant');
        expect(m.source).toBe('hook');
        expect(m.blocks).toEqual([
            {
                type: 'text',
                text: 'hi'
            }
        ]);
    });
});
