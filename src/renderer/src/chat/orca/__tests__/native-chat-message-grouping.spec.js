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
import { buildNativeChatRenderItems, orderNativeChatMessages } from "../native-chat-message-grouping.js";
import { NATIVE_CHAT_STREAMING_ID } from "../shared/native-chat-streaming.js";
function msg(overrides) {
    return {
        role: 'assistant',
        blocks: [],
        timestamp: 0,
        source: 'transcript',
        ...overrides
    };
}
describe('orderNativeChatMessages', ()=>{
    it('orders by ascending timestamp, null first', ()=>{
        const ordered = orderNativeChatMessages([
            msg({
                id: 'b',
                timestamp: 20
            }),
            msg({
                id: 'a',
                timestamp: 10
            }),
            msg({
                id: 'n',
                timestamp: null
            })
        ]);
        expect(ordered.map((m)=>m.id)).toEqual([
            'n',
            'a',
            'b'
        ]);
    });
    it('breaks timestamp ties by id deterministically', ()=>{
        const ordered = orderNativeChatMessages([
            msg({
                id: 'z',
                timestamp: 5
            }),
            msg({
                id: 'a',
                timestamp: 5
            })
        ]);
        expect(ordered.map((m)=>m.id)).toEqual([
            'a',
            'z'
        ]);
    });
    it('sorts the streaming preview after real content but before optimistic echoes', ()=>{
        const ordered = orderNativeChatMessages([
            msg({
                id: 'pending:abc',
                role: 'user',
                timestamp: 20,
                source: 'scrape'
            }),
            msg({
                id: NATIVE_CHAT_STREAMING_ID,
                timestamp: null
            }),
            msg({
                id: 'real-user',
                role: 'user',
                timestamp: 10
            })
        ]);
        expect(ordered.map((m)=>m.id)).toEqual([
            'real-user',
            'streaming',
            'pending:abc'
        ]);
    });
});
describe('buildNativeChatRenderItems', ()=>{
    it('renders messages in order', ()=>{
        const items = buildNativeChatRenderItems([
            msg({
                id: 'u',
                role: 'user',
                timestamp: 1,
                blocks: [
                    {
                        type: 'text',
                        text: 'hi'
                    }
                ]
            }),
            msg({
                id: 'a',
                role: 'assistant',
                timestamp: 2,
                blocks: [
                    {
                        type: 'text',
                        text: 'hello'
                    }
                ]
            })
        ]);
        expect(items.map((i)=>i.id)).toEqual([
            'u',
            'a'
        ]);
        expect(items[0]?.kind).toBe('message');
    });
    it('pairs a tool-call with its tool-result into one step', ()=>{
        const items = buildNativeChatRenderItems([
            msg({
                id: 'a',
                role: 'assistant',
                timestamp: 1,
                blocks: [
                    {
                        type: 'tool-call',
                        name: 'Bash',
                        input: {
                            cmd: 'ls'
                        }
                    }
                ]
            }),
            msg({
                id: 't',
                role: 'tool',
                timestamp: 2,
                blocks: [
                    {
                        type: 'tool-result',
                        output: 'file.txt'
                    }
                ]
            })
        ]);
        const steps = items.filter((i)=>i.kind === 'tool-step');
        expect(steps).toHaveLength(1);
        const step = steps[0];
        if (step?.kind !== 'tool-step') {
            throw new Error('expected tool-step');
        }
        expect(step.step.call.name).toBe('Bash');
        expect(step.step.result?.output).toBe('file.txt');
    });
    it('leaves an unanswered tool-call in flight (result null)', ()=>{
        const items = buildNativeChatRenderItems([
            msg({
                id: 'a',
                role: 'assistant',
                timestamp: 1,
                blocks: [
                    {
                        type: 'tool-call',
                        name: 'Read',
                        input: {}
                    }
                ]
            })
        ]);
        const step = items.find((i)=>i.kind === 'tool-step');
        if (step?.kind !== 'tool-step') {
            throw new Error('expected tool-step');
        }
        expect(step.step.result).toBeNull();
    });
    it('separates prose blocks from tool blocks in the same message', ()=>{
        const items = buildNativeChatRenderItems([
            msg({
                id: 'a',
                role: 'assistant',
                timestamp: 1,
                blocks: [
                    {
                        type: 'text',
                        text: 'running it'
                    },
                    {
                        type: 'tool-call',
                        name: 'Bash',
                        input: {}
                    }
                ]
            })
        ]);
        expect(items.map((i)=>i.kind)).toEqual([
            'message',
            'tool-step'
        ]);
        const message = items[0];
        if (message?.kind !== 'message') {
            throw new Error('expected message');
        }
        expect(message.blocks).toEqual([
            {
                type: 'text',
                text: 'running it'
            }
        ]);
    });
});
