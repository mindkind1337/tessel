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
import { normalizeImageTranscriptMessages } from "../shared/native-chat-image-transcript-markers.js";
import { assembleNativeChatSession } from "../native-chat-session-assembler.js";
import { applyAppends, createIncrementalAssembler, reset } from "../native-chat-incremental-assembler.js";
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
function fullRebuild(messages) {
    return assembleNativeChatSession({
        sources: {
            transcript: messages
        },
        sessionId: 's1',
        agent: 'claude'
    }).messages;
}
function incrementalPrefixes(base, batches) {
    const assembler = createIncrementalAssembler();
    const out = [];
    out.push(reset(assembler, base));
    for (const batch of batches){
        out.push(applyAppends(assembler, batch));
    }
    return out;
}
describe('incremental assembler — oracle differential', ()=>{
    const base = [
        msg({
            id: 'a',
            timestamp: 10,
            role: 'user',
            blocks: [
                {
                    type: 'text',
                    text: 'hello'
                }
            ]
        }),
        msg({
            id: 'b',
            timestamp: 20,
            blocks: [
                {
                    type: 'text',
                    text: 'partial'
                }
            ],
            source: 'hook'
        })
    ];
    const batches = [
        [
            msg({
                id: 'c',
                timestamp: 30,
                blocks: [
                    {
                        type: 'text',
                        text: 'c'
                    }
                ]
            })
        ],
        [],
        [
            msg({
                id: 'b',
                timestamp: 20,
                source: 'transcript',
                blocks: [
                    {
                        type: 'text',
                        text: 'final'
                    }
                ]
            })
        ],
        [
            msg({
                id: 'd',
                timestamp: 5,
                blocks: [
                    {
                        type: 'text',
                        text: 'early'
                    }
                ]
            })
        ],
        [
            msg({
                id: 'a-scrape',
                timestamp: 10,
                role: 'user',
                source: 'scrape',
                blocks: [
                    {
                        type: 'text',
                        text: 'hello'
                    }
                ]
            })
        ],
        [
            msg({
                id: 'e',
                timestamp: 40,
                role: 'user',
                blocks: [
                    {
                        type: 'text',
                        text: 'hello'
                    }
                ]
            })
        ],
        [
            msg({
                id: 'f',
                timestamp: null,
                blocks: [
                    {
                        type: 'text',
                        text: 'f'
                    }
                ]
            })
        ],
        [
            msg({
                id: 'c',
                timestamp: 30,
                blocks: [
                    {
                        type: 'text',
                        text: 'c'
                    }
                ]
            })
        ],
        [
            msg({
                id: 'g',
                timestamp: 50,
                blocks: [
                    {
                        type: 'text',
                        text: 'g'
                    }
                ]
            }),
            msg({
                id: 'h',
                timestamp: 60,
                blocks: [
                    {
                        type: 'text',
                        text: 'h'
                    }
                ]
            })
        ]
    ];
    it('matches a full rebuild for every prefix of the append sequence', ()=>{
        const inc = incrementalPrefixes(base, batches);
        let cumulative = [
            ...base
        ];
        expect(inc[0]).toEqual(fullRebuild(cumulative));
        for(let i = 0; i < batches.length; i += 1){
            cumulative = [
                ...cumulative,
                ...batches[i]
            ];
            expect(inc[i + 1]).toEqual(fullRebuild(cumulative));
        }
    });
    it('keeps prior message object identity on a pure tail append', ()=>{
        const assembler = createIncrementalAssembler();
        reset(assembler, base);
        const before = assembler.messages;
        const tail = msg({
            id: 'z',
            timestamp: 99,
            blocks: [
                {
                    type: 'text',
                    text: 'z'
                }
            ]
        });
        const after = applyAppends(assembler, [
            tail
        ]);
        expect(after).not.toBe(before);
        expect(after[0]).toBe(before[0]);
        expect(after.at(-1)).toBe(tail);
    });
    it('returns the same reference for an empty append batch', ()=>{
        const assembler = createIncrementalAssembler();
        reset(assembler, base);
        const out = assembler.messages;
        expect(applyAppends(assembler, [])).toBe(out);
    });
    it('keeps equal-timestamp image companions ahead of prompts for normalization', ()=>{
        const assembler = createIncrementalAssembler();
        const prompt = msg({
            id: 'a-prompt',
            role: 'user',
            timestamp: 100,
            blocks: [
                {
                    type: 'text',
                    text: '[Image #1] inspect this'
                }
            ]
        });
        const companion = msg({
            id: 'z-companion',
            role: 'user',
            timestamp: 100,
            blocks: [
                {
                    type: 'text',
                    text: '[Image: source: /tmp/image.png]'
                }
            ]
        });
        const assembled = reset(assembler, [
            prompt,
            companion
        ]);
        expect(assembled.map((message)=>message.id)).toEqual([
            'z-companion',
            'a-prompt'
        ]);
        expect(normalizeImageTranscriptMessages(assembled)).toEqual([
            {
                ...prompt,
                blocks: [
                    {
                        type: 'image-ref',
                        path: '/tmp/image.png'
                    },
                    {
                        type: 'text',
                        text: 'inspect this'
                    }
                ]
            }
        ]);
    });
    it('does not cross-fold distinct equal-timestamp image turns', ()=>{
        const assembler = createIncrementalAssembler();
        const firstPrompt = msg({
            id: 'a-first-prompt',
            role: 'user',
            timestamp: 100,
            blocks: [
                {
                    type: 'text',
                    text: '[Image #1] inspect the first'
                }
            ]
        });
        const firstCompanion = msg({
            id: 'z-first-companion',
            role: 'user',
            timestamp: 100,
            blocks: [
                {
                    type: 'text',
                    text: '[Image: source: /tmp/first.png]'
                }
            ]
        });
        const secondPrompt = msg({
            id: 'b-second-prompt',
            role: 'user',
            timestamp: 100,
            blocks: [
                {
                    type: 'text',
                    text: '[Image #1] inspect the second'
                }
            ]
        });
        const secondCompanion = msg({
            id: 'y-second-companion',
            role: 'user',
            timestamp: 100,
            blocks: [
                {
                    type: 'text',
                    text: '[Image: source: /tmp/second.png]'
                }
            ]
        });
        const assembled = reset(assembler, [
            firstPrompt,
            firstCompanion,
            secondPrompt,
            secondCompanion
        ]);
        expect(normalizeImageTranscriptMessages(assembled)).toEqual([
            {
                ...firstPrompt,
                blocks: [
                    {
                        type: 'image-ref',
                        path: '/tmp/first.png'
                    },
                    {
                        type: 'text',
                        text: 'inspect the first'
                    }
                ]
            },
            {
                ...secondPrompt,
                blocks: [
                    {
                        type: 'image-ref',
                        path: '/tmp/second.png'
                    },
                    {
                        type: 'text',
                        text: 'inspect the second'
                    }
                ]
            }
        ]);
    });
});
