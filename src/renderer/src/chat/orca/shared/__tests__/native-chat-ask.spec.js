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
import { NATIVE_CHAT_INTERRUPTED_STATUS_TEXT } from "../native-chat-types.js";
import { extractPendingAsk, nativeChatAskDismissKey, parseAskFromStatus, resolveNativeChatAsk } from "../native-chat-ask.js";
function message(id, blocks) {
    return {
        id,
        role: 'assistant',
        blocks,
        timestamp: 1,
        source: 'transcript'
    };
}
function call(name, input) {
    return {
        type: 'tool-call',
        name,
        input
    };
}
function result() {
    return {
        type: 'tool-result',
        output: 'ok'
    };
}
function interrupted(id) {
    return {
        id,
        role: 'system',
        blocks: [
            {
                type: 'text',
                text: NATIVE_CHAT_INTERRUPTED_STATUS_TEXT
            }
        ],
        timestamp: 1,
        source: 'transcript'
    };
}
function userTurn(id, text) {
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
function toolTurn(id) {
    return {
        id,
        role: 'tool',
        blocks: [
            result()
        ],
        timestamp: 1,
        source: 'transcript'
    };
}
const QUESTIONS_INPUT = {
    questions: [
        {
            question: 'Deploy?',
            options: [
                {
                    label: 'Yes'
                },
                {
                    label: 'No'
                }
            ]
        }
    ]
};
describe('nativeChatAskDismissKey', ()=>{
    it('uses the full canonical prompt and stays stable across object instances', ()=>{
        const first = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT));
        const same = parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT));
        const changed = parseAskFromStatus(JSON.stringify({
            questions: [
                {
                    question: 'Deploy?',
                    options: [
                        {
                            label: 'Later'
                        }
                    ]
                }
            ]
        }));
        expect(nativeChatAskDismissKey(first)).toBe(nativeChatAskDismissKey(same));
        expect(nativeChatAskDismissKey(first)).not.toBe(nativeChatAskDismissKey(changed));
        expect(nativeChatAskDismissKey(null)).toBeNull();
    });
});
describe('extractPendingAsk', ()=>{
    it('recognizes an unregistered tool whose input matches the canonical questions shape', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('CustomAskTool', QUESTIONS_INPUT)
            ])
        ]);
        expect(pending?.questions[0]?.question).toBe('Deploy?');
    });
    it('resolves calls FIFO so a sibling result cannot clear a newer pending ask', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('Bash', {
                    command: 'ls'
                }),
                call('AskUserQuestion', QUESTIONS_INPUT),
                result()
            ])
        ]);
        expect(pending?.questions[0]?.question).toBe('Deploy?');
    });
    it("clears the ask when its own result arrives, keeping the newest ask's identity", ()=>{
        const first = {
            questions: [
                {
                    question: 'First?',
                    options: []
                }
            ]
        };
        const pending = extractPendingAsk([
            message('m1', [
                call('AskUserQuestion', first),
                call('AskUserQuestion', QUESTIONS_INPUT),
                result()
            ])
        ]);
        expect(pending?.questions[0]?.question).toBe('Deploy?');
    });
    it('does not strand an answered ask behind a tool call orphaned by an interrupt', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('Bash', {
                    command: 'sleep 999'
                })
            ]),
            interrupted('m2'),
            message('m3', [
                call('AskUserQuestion', QUESTIONS_INPUT)
            ]),
            message('m4', [
                result()
            ])
        ]);
        expect(pending).toBeNull();
    });
    it('drops an ask abandoned by an interrupt', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('AskUserQuestion', QUESTIONS_INPUT)
            ]),
            interrupted('m2')
        ]);
        expect(pending).toBeNull();
    });
    it('keeps an ask that is still awaiting its result after an earlier interrupt', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('Bash', {
                    command: 'sleep 999'
                })
            ]),
            interrupted('m2'),
            message('m3', [
                call('AskUserQuestion', QUESTIONS_INPUT)
            ])
        ]);
        expect(pending?.questions[0]?.question).toBe('Deploy?');
    });
    it('drops an ask the user typed past instead of answering', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('AskUserQuestion', QUESTIONS_INPUT)
            ]),
            userTurn('m2', 'never mind, do this instead'),
            message('m3', [
                {
                    type: 'text',
                    text: 'on it'
                }
            ])
        ]);
        expect(pending).toBeNull();
    });
    it('does not strand an answered ask behind an orphan left by a plain-text interrupt', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('Bash', {
                    command: 'sleep 999'
                })
            ]),
            userTurn('m2', '[Request interrupted by user]'),
            message('m3', [
                call('AskUserQuestion', QUESTIONS_INPUT)
            ]),
            toolTurn('m4')
        ]);
        expect(pending).toBeNull();
    });
    it('resolves an ask whose result arrives on its own tool-role turn', ()=>{
        const pending = extractPendingAsk([
            message('m1', [
                call('AskUserQuestion', QUESTIONS_INPUT)
            ]),
            toolTurn('m2')
        ]);
        expect(pending).toBeNull();
    });
    it('ignores malformed question payloads', ()=>{
        expect(extractPendingAsk([
            message('m1', [
                call('AskUserQuestion', {
                    questions: []
                }),
                call('AskUserQuestion', {
                    questions: [
                        {}
                    ]
                }),
                call('AskUserQuestion', 'not-an-object')
            ])
        ])).toBeNull();
    });
});
describe('parseAskFromStatus', ()=>{
    it('accepts the canonical shape from any tool name and rejects broken JSON', ()=>{
        expect(parseAskFromStatus(JSON.stringify(QUESTIONS_INPUT), 'SomeNewTool')?.questions).toHaveLength(1);
        expect(parseAskFromStatus('{not json', 'AskUserQuestion')).toBeNull();
        expect(parseAskFromStatus(null)).toBeNull();
    });
    it('parses string options into labels', ()=>{
        const prompt = parseAskFromStatus(JSON.stringify({
            questions: [
                {
                    question: 'Pick',
                    options: [
                        'a',
                        'b'
                    ]
                }
            ]
        }));
        expect(prompt?.questions[0]?.options.map((o)=>o.label)).toEqual([
            'a',
            'b'
        ]);
    });
});
describe('resolveNativeChatAsk', ()=>{
    const transcript = [
        message('m1', [
            call('AskUserQuestion', QUESTIONS_INPUT)
        ])
    ];
    it('withholds transcript state until the read settles', ()=>{
        expect(resolveNativeChatAsk({
            liveAsk: null,
            messages: transcript,
            transcriptSettled: false
        })).toBeNull();
        expect(resolveNativeChatAsk({
            liveAsk: null,
            messages: transcript,
            transcriptSettled: true
        }))?.toMatchObject(QUESTIONS_INPUT);
    });
    it('keeps a live ask authoritative while transcript history is unsettled', ()=>{
        const liveAsk = {
            questions: [
                {
                    question: 'Live?',
                    options: [],
                    multiSelect: false
                }
            ]
        };
        expect(resolveNativeChatAsk({
            liveAsk,
            messages: transcript,
            transcriptSettled: false
        })).toBe(liveAsk);
    });
});
