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
import { nativeChatTurnAnswerRows, nativeChatTurnFold } from "../native-chat-turn-fold.js";
function row(overrides = {}) {
    return {
        turnKey: 'turn-1',
        role: 'assistant',
        rendersProse: true,
        outlivesTurn: false,
        ...overrides
    };
}
const TURN = [
    row({
        role: 'user'
    }),
    row(),
    row({
        rendersProse: false
    }),
    row(),
    row()
];
const SETTLED = new Set([
    'turn-1'
]);
const NONE = new Set();
describe('nativeChatTurnAnswerRows', ()=>{
    it('names the last assistant row that renders prose, not the first', ()=>{
        expect(nativeChatTurnAnswerRows(TURN).get('turn-1')).toBe(4);
    });
    it('ignores rows that render no prose, so a trailing tool run is not the answer', ()=>{
        const rows = [
            row({
                role: 'user'
            }),
            row(),
            row({
                rendersProse: false
            })
        ];
        expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(1);
    });
    it('ignores reasoning and system rows, which are never the agent answering', ()=>{
        const rows = [
            row({
                role: 'user'
            }),
            row(),
            row({
                role: 'reasoning'
            }),
            row({
                role: 'system'
            })
        ];
        expect(nativeChatTurnAnswerRows(rows).get('turn-1')).toBe(1);
    });
    it('reports no answer for a turn that only ran tools', ()=>{
        const rows = [
            row({
                role: 'user'
            }),
            row({
                rendersProse: false
            })
        ];
        expect(nativeChatTurnAnswerRows(rows).has('turn-1')).toBe(false);
    });
});
describe('nativeChatTurnFold', ()=>{
    it('folds a settled turn to its answer', ()=>{
        const { foldedRows } = nativeChatTurnFold({
            rows: TURN,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: NONE
        });
        expect([
            ...foldedRows
        ].sort()).toEqual([
            1,
            2,
            3
        ]);
    });
    it("never folds the reader's own message, which anchors the turn", ()=>{
        const { foldedRows } = nativeChatTurnFold({
            rows: TURN,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: NONE
        });
        expect(foldedRows.has(0)).toBe(false);
    });
    it('folds nothing while the turn is still running', ()=>{
        const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
            rows: TURN,
            settledTurnKeys: NONE,
            expandedTurnKeys: NONE
        });
        expect(foldedRows.size).toBe(0);
        expect(foldableTurnKeys.size).toBe(0);
    });
    it('reveals every row of a turn the reader opened, and still reports it foldable', ()=>{
        const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
            rows: TURN,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: SETTLED
        });
        expect(foldedRows.size).toBe(0);
        expect([
            ...foldableTurnKeys
        ]).toEqual([
            'turn-1'
        ]);
    });
    it('keeps a spawn roster or background task out of the fold', ()=>{
        const rows = [
            row({
                role: 'user'
            }),
            row(),
            row({
                outlivesTurn: true
            }),
            row()
        ];
        const { foldedRows } = nativeChatTurnFold({
            rows,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: NONE
        });
        expect(foldedRows.has(2)).toBe(false);
        expect(foldedRows.has(1)).toBe(true);
    });
    it('folds a prose-less turn whole, so its commands do not return to the transcript', ()=>{
        const rows = [
            row({
                role: 'user'
            }),
            row({
                rendersProse: false
            }),
            row({
                rendersProse: false
            })
        ];
        const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
            rows,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: NONE
        });
        expect([
            ...foldedRows
        ].sort()).toEqual([
            1,
            2
        ]);
        expect([
            ...foldableTurnKeys
        ]).toEqual([
            'turn-1'
        ]);
    });
    it('offers no disclosure on a turn that is nothing but its answer', ()=>{
        const rows = [
            row({
                role: 'user'
            }),
            row()
        ];
        const { foldedRows, foldableTurnKeys } = nativeChatTurnFold({
            rows,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: NONE
        });
        expect(foldedRows.size).toBe(0);
        expect(foldableTurnKeys.size).toBe(0);
    });
    it('folds each settled turn to its own answer and leaves a running turn alone', ()=>{
        const rows = [
            row({
                turnKey: 'turn-1',
                role: 'user'
            }),
            row({
                turnKey: 'turn-1'
            }),
            row({
                turnKey: 'turn-1'
            }),
            row({
                turnKey: 'turn-2',
                role: 'user'
            }),
            row({
                turnKey: 'turn-2'
            }),
            row({
                turnKey: 'turn-2'
            })
        ];
        const { foldedRows } = nativeChatTurnFold({
            rows,
            settledTurnKeys: new Set([
                'turn-1'
            ]),
            expandedTurnKeys: NONE
        });
        expect([
            ...foldedRows
        ]).toEqual([
            1
        ]);
    });
    it('leaves rows before the first prompt alone', ()=>{
        const rows = [
            row({
                turnKey: undefined
            }),
            row({
                turnKey: undefined
            })
        ];
        const { foldedRows } = nativeChatTurnFold({
            rows,
            settledTurnKeys: SETTLED,
            expandedTurnKeys: NONE
        });
        expect(foldedRows.size).toBe(0);
    });
});
