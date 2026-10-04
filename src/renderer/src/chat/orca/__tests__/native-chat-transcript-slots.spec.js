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
import { selectNativeChatTurnStatuses } from "../shared/native-chat-turn-status.js";
import { selectStructuredAgentSettledTurns } from "../shared/structured-agent-session-turn-timing.js";
import { buildNativeChatTranscriptSlots, nativeChatSlotIndexOf } from "../native-chat-transcript-slots.js";
const NO_STATUSES = {
    active: null,
    completedByTurn: {}
};
function text(id, body, role = 'assistant') {
    return {
        id,
        role,
        blocks: [
            {
                type: 'text',
                text: body
            }
        ],
        timestamp: 1,
        source: 'transcript'
    };
}
function build(messages, overrides = {}) {
    let turn;
    const turnKeys = messages.map((message)=>{
        if (message.role === 'user') {
            turn = message.id;
        }
        return turn;
    });
    return buildNativeChatTranscriptSlots({
        messages,
        turnKeys,
        latestUserIndex: messages.findLastIndex((message)=>message.role === 'user'),
        currentTurnKey: undefined,
        receipts: new Map(),
        turnStatuses: NO_STATUSES,
        turnDiffs: new Map(),
        showTurnStatus: true,
        expandedTurnKeys: new Set(),
        isWorking: false,
        lifecycleWorking: false,
        ...overrides
    });
}
function toolRun(id) {
    return {
        id,
        role: 'assistant',
        blocks: [
            {
                type: 'tool-call',
                name: 'shell',
                input: {
                    command: 'ls'
                },
                state: 'completed'
            }
        ],
        timestamp: 1,
        source: 'transcript'
    };
}
describe('transcript slots', ()=>{
    it('marks the last row that speaks or acts as the trailing run', ()=>{
        const trailing = (messages)=>build(messages).filter((slot)=>slot.trailingRun).map((slot)=>slot.message.id);
        expect(trailing([
            text('u', 'go', 'user'),
            toolRun('a'),
            text('b', 'Done.')
        ])).toEqual([
            'b'
        ]);
        expect(trailing([
            text('u', 'go', 'user'),
            toolRun('a'),
            toolRun('b')
        ])).toEqual([
            'b'
        ]);
        expect(trailing([
            text('u', 'go', 'user'),
            toolRun('a'),
            text('r', 'hmm', 'reasoning')
        ])).toEqual([
            'a'
        ]);
        expect(trailing([
            toolRun('a'),
            text('u', 'again', 'user')
        ])).toEqual([
            'a'
        ]);
    });
    it('keeps the run above an approval receipt trailing, but not above a question', ()=>{
        const resolution = {
            state: 'resolved',
            selectedOptionId: 'yes',
            resolvedBy: 'desktop',
            resolvedAt: 1
        };
        const receipts = new Map([
            [
                'approval',
                {
                    kind: 'approval',
                    title: 'Run?',
                    detail: 'ls',
                    options: [],
                    resolution
                }
            ],
            [
                'question',
                {
                    kind: 'question',
                    question: 'Which?',
                    options: [],
                    resolution
                }
            ]
        ]);
        const trailing = (receiptId)=>build([
                text('u', 'go', 'user'),
                toolRun('a'),
                text(receiptId, 'Run?', 'system')
            ], {
                receipts
            }).filter((slot)=>slot.trailingRun).map((slot)=>slot.message.id);
        expect(trailing('approval')).toEqual([
            'a'
        ]);
        expect(trailing('question')).toEqual([
            'question'
        ]);
    });
    it('gives no slot to a message with nothing to draw', ()=>{
        const slots = build([
            text('a', 'visible'),
            text('blank', ''),
            text('b', 'also visible')
        ]);
        expect(slots.map((slot)=>slot.message.id)).toEqual([
            'a',
            'b'
        ]);
    });
    it('keeps a message whose only content is a turn status under it', ()=>{
        const status = {
            startedAt: 1,
            thinking: false,
            workedSeconds: 4
        };
        const slots = build([
            text('u', '', 'user')
        ], {
            latestUserIndex: 0,
            turnStatuses: {
                active: status,
                completedByTurn: {}
            }
        });
        expect(slots).toHaveLength(1);
        expect(slots[0]?.status).toBe(status);
    });
    it('keeps a message whose only content is its turn diff rollup', ()=>{
        const diff = {
            files: [],
            added: 1,
            removed: 0,
            truncated: false
        };
        const slots = build([
            text('u', 'ask', 'user'),
            text('blank', '')
        ], {
            turnDiffs: new Map([
                [
                    'u',
                    diff
                ]
            ])
        });
        expect(slots.map((slot)=>slot.message.id)).toEqual([
            'u',
            'blank'
        ]);
        expect(slots[1]?.turnDiff).toBe(diff);
    });
    it('keeps a resolved prompt that stands in for a message drawing nothing', ()=>{
        const receipt = {
            kind: 'approval',
            title: 'Run it?',
            resolution: {
                state: 'resolved',
                selectedOptionId: 'yes'
            }
        };
        const slots = build([
            text('blank', '')
        ], {
            receipts: new Map([
                [
                    'blank',
                    receipt
                ]
            ])
        });
        expect(slots).toHaveLength(1);
        expect(slots[0]?.receipt).toBe(receipt);
    });
    it('leaves the running turn status to the single transcript-tail indicator', ()=>{
        const status = {
            startedAt: 1,
            thinking: false,
            workedSeconds: null
        };
        const slots = build([
            text('u', 'ask', 'user')
        ], {
            latestUserIndex: 0,
            turnStatuses: {
                active: status,
                completedByTurn: {}
            },
            isWorking: true
        });
        expect(slots[0]?.status).toBeUndefined();
    });
    it('reserves a height for every slot it keeps', ()=>{
        for (const slot of build([
            text('a', 'one'),
            text('b', 'two\nlines')
        ])){
            expect(slot.estimatedHeight).toBeGreaterThan(0);
        }
    });
    it('finds the slot a reveal names, and reports -1 for one that has no slot', ()=>{
        const slots = build([
            text('a', 'visible'),
            text('blank', ''),
            text('b', 'also visible')
        ]);
        expect(nativeChatSlotIndexOf(slots, 'b')).toBe(1);
        expect(nativeChatSlotIndexOf(slots, 'blank')).toBe(-1);
        expect(nativeChatSlotIndexOf(slots, undefined)).toBe(-1);
    });
});
describe('a send the host rejected', ()=>{
    const DIAGNOSTIC = 'The provider stopped before it finished starting: claude stream-json exited (code 1): claude: not signed in.';
    it('leaves the row naming the cause on screen', ()=>{
        const messages = [
            text('orca:first-start', DIAGNOSTIC, 'system'),
            text('orca:dead', 'Reply with exactly: DEAD', 'user'),
            text('orca:restart-exit', DIAGNOSTIC, 'system')
        ];
        const settledByTurn = selectStructuredAgentSettledTurns([], [
            {
                clientMessageId: 'dead',
                fence: 5,
                payloadFingerprint: 'fp',
                dispatchState: 'rejected',
                providerItemId: null,
                reason: 'provider_write_failed: claude: not signed in',
                submittedAt: 1,
                resolvedAt: 2
            }
        ]);
        const turnStatuses = selectNativeChatTurnStatuses({
            'orca:dead': {
                startedAt: 900,
                workedSeconds: 0
            }
        }, {
            activeTurnKey: 'orca:dead',
            isWorking: false,
            thinking: false,
            settledByTurn
        });
        const slots = build(messages, {
            turnStatuses
        });
        expect(slots.map((slot)=>[
                slot.message.id,
                slot.folded,
                slot.status
            ])).toEqual([
            [
                'orca:first-start',
                false,
                undefined
            ],
            [
                'orca:dead',
                false,
                undefined
            ],
            [
                'orca:restart-exit',
                false,
                undefined
            ]
        ]);
    });
});
describe('a settled turn (Tessel)', ()=>{
    it('folds its work but keeps its error and warning notices in view', ()=>{
        const notice = (id, body, tone)=>({ ...text(id, body, 'system'), blocks: [{ type: 'text', text: body, ...(tone ? { tone } : {}) }] })
        const messages = [
            text('u', 'go', 'user'),
            toolRun('a'),
            notice('e', 'content filter', 'error'),
            notice('w', 'careful', 'warning'),
            notice('i', 'fyi'),
            text('b', 'Done.')
        ];
        const slots = build(messages, {
            turnStatuses: { active: null, completedByTurn: { u: { startedAt: 1, workedSeconds: 3 } } }
        });
        // A folded row gets no slot (its turn's status row stands in for it).
        expect(slots.map((slot)=>slot.message.id)).toEqual(['u', 'e', 'w', 'b']);
        expect(slots.every((slot)=>!slot.folded)).toBe(true);
    });
    it("keeps a slash command's \"Ran /compact\" row in view, as the session notices", ()=>{
        const messages = [
            text('u', 'Then say done.', 'user'),
            text('b', 'Done.'),
            text('command:1-1', 'Ran /compact', 'system')
        ];
        const slots = build(messages, {
            turnStatuses: { active: null, completedByTurn: { u: { startedAt: 1, workedSeconds: 2 } } }
        });
        expect(slots.map((slot)=>slot.message.id)).toEqual(['u', 'b', 'command:1-1']);
    });
});
