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
import { expect, it } from 'vitest';
import { createNativeChatMessageListProjection } from "../native-chat-message-list-projection.js";
import { orderNativeChatMessages } from "../native-chat-message-grouping.js";
import { stripNoiseMessages } from "../native-chat-noise.js";
import { foldToolMessages } from "../native-chat-tool-fold.js";
function message(id, timestamp, blocks, role = 'assistant') {
    return {
        id,
        timestamp,
        blocks,
        role,
        source: 'transcript'
    };
}
it('retains settled folded runs while exposing changed tools, metadata, and attribution boundaries', ()=>{
    const project = createNativeChatMessageListProjection();
    const prose = message('prose', 1, [
        {
            type: 'text',
            text: 'Inspecting the workspace'
        }
    ]);
    const call = message('call', 2, [
        {
            type: 'tool-call',
            name: 'shell',
            input: {
                command: 'pwd'
            }
        }
    ]);
    const result = message('result', 3, [
        {
            type: 'tool-result',
            output: '/workspace'
        }
    ], 'tool');
    const prompt = message('prompt', 4, [
        {
            type: 'text',
            text: 'Next task'
        }
    ], 'user');
    const tail = message('tail', 5, [
        {
            type: 'text',
            text: 'Answer'
        }
    ]);
    const initial = project([
        prose,
        call,
        result,
        prompt,
        tail
    ]);
    expect(project([
        prose,
        call,
        result,
        prompt,
        tail
    ])).toBe(initial);
    const streamed = project([
        prose,
        call,
        result,
        prompt,
        {
            ...tail,
            blocks: [
                {
                    type: 'text',
                    text: 'Answer grows'
                }
            ]
        }
    ]);
    expect(streamed[0]).toBe(initial[0]);
    expect(streamed.at(-1)).not.toBe(initial.at(-1));
    const lateResult = {
        ...result,
        blocks: [
            {
                type: 'tool-result',
                output: '/different'
            }
        ]
    };
    const interruption = message('interrupt', 2.5, [
        {
            type: 'text',
            text: '[Request interrupted by user]'
        }
    ], 'user');
    const earlier = message('earlier', 0, [
        {
            type: 'text',
            text: 'Earlier task'
        }
    ], 'user');
    const scenarios = [
        [
            prose,
            call,
            lateResult,
            prompt,
            tail
        ],
        [
            prose,
            call,
            interruption,
            result,
            prompt,
            tail
        ],
        [
            tail,
            result,
            prompt,
            call,
            prose,
            earlier
        ],
        [
            prose,
            result,
            prompt,
            tail
        ],
        [
            prose,
            call,
            result
        ],
        [
            {
                ...prose,
                source: 'hook',
                turnId: 'different'
            },
            call,
            result
        ],
        [
            {
                ...prose,
                timestamp: 4
            },
            call,
            result,
            prompt,
            tail
        ],
        structuredClone([
            prose,
            call,
            result,
            prompt,
            tail
        ]),
        []
    ];
    for (const messages of scenarios){
        expect(project(messages)).toEqual(stripNoiseMessages(foldToolMessages(orderNativeChatMessages(messages))));
    }
    expect(project([
        prose,
        call,
        result
    ])[0]).not.toBe(initial[0]);
});
it('leaves producer-owned messages and blocks untouched', ()=>{
    const project = createNativeChatMessageListProjection();
    const prose = message('prose', 1, [
        {
            type: 'text',
            text: 'Working'
        }
    ]);
    const call = message('call', 2, [
        {
            type: 'tool-call',
            name: 'shell',
            input: {
                command: 'pwd'
            }
        }
    ]);
    const result = message('result', 3, [
        {
            type: 'tool-result',
            output: '/workspace'
        }
    ], 'tool');
    const later = message('later', 4, [
        {
            type: 'tool-call',
            name: 'read',
            input: {
                path: 'a.ts'
            }
        }
    ], 'tool');
    const input = [
        prose,
        call,
        result,
        later
    ];
    const snapshot = structuredClone(input);
    const folded = project(input);
    expect(folded[0]?.blocks).toHaveLength(4);
    expect(folded[0]?.blocks[0]).toBe(prose.blocks[0]);
    project([
        ...input,
        message('tail', 5, [
            {
                type: 'text',
                text: 'Answer'
            }
        ])
    ]);
    expect(input).toEqual(snapshot);
    expect(prose.blocks).toHaveLength(1);
});
