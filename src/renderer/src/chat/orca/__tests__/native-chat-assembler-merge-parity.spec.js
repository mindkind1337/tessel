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
import { NATIVE_CHAT_SOURCE_PRIORITY } from "../shared/native-chat-types.js";
import { mergeNativeChatMessagesWith } from "../shared/native-chat-merge.js";
import { assembleNativeChatSession } from "../native-chat-session-assembler.js";
function msg(overrides) {
    return {
        role: 'assistant',
        blocks: [
            {
                type: 'text',
                text: overrides.id
            }
        ],
        timestamp: 0,
        source: 'transcript',
        ...overrides
    };
}
describe('assembler ↔ id-merge parity on single-source data', ()=>{
    it('produces the same ids in the same order as the id-only merge', ()=>{
        const transcript = [
            msg({
                id: 'u1',
                role: 'user',
                timestamp: 10,
                blocks: [
                    {
                        type: 'text',
                        text: 'run tests'
                    }
                ]
            }),
            msg({
                id: 'a1',
                timestamp: 20,
                blocks: [
                    {
                        type: 'text',
                        text: 'ok'
                    }
                ]
            }),
            msg({
                id: 'u2',
                role: 'user',
                timestamp: 30,
                blocks: [
                    {
                        type: 'text',
                        text: 'run tests'
                    }
                ]
            }),
            msg({
                id: 'a2',
                timestamp: 40,
                blocks: [
                    {
                        type: 'text',
                        text: 'done'
                    }
                ]
            })
        ];
        const assembled = assembleNativeChatSession({
            sources: {
                transcript
            },
            sessionId: 's1',
            agent: 'claude'
        }).messages;
        const merged = mergeNativeChatMessagesWith([], transcript, NATIVE_CHAT_SOURCE_PRIORITY);
        expect(assembled.map((m)=>m.id)).toEqual(merged.map((m)=>m.id));
        expect(assembled).toHaveLength(transcript.length);
    });
});
