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
import { isSubagentGroupFallbackText, isTerminalSubagentState, normalizeSubagentState, subagentGroupFallbackText, summarizeSubagentGroup } from "../native-chat-subagent-summary.js";
function agent(entry) {
    return {
        id: 'a',
        label: 'task',
        state: 'working',
        ...entry
    };
}
describe('summarizeSubagentGroup', ()=>{
    it('collapses in-flight children into one working count', ()=>{
        const summary = summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'working'
            }),
            agent({
                id: 'c',
                state: 'completed'
            })
        ]);
        expect(summary).toMatchObject({
            total: 3,
            working: 2,
            settledState: null,
            settledCount: 0
        });
    });
    it('ranks the settled verdict worst-first and reports ✓ completed last', ()=>{
        const cascade = [
            [
                [
                    'failed',
                    'stopped',
                    'idle',
                    'completed'
                ],
                'failed'
            ],
            [
                [
                    'stopped',
                    'idle',
                    'completed'
                ],
                'stopped'
            ],
            [
                [
                    'unverifiable',
                    'idle',
                    'completed'
                ],
                'unverifiable'
            ],
            [
                [
                    'idle',
                    'completed'
                ],
                'idle'
            ],
            [
                [
                    'completed',
                    'completed'
                ],
                'completed'
            ]
        ];
        for (const [states, expected] of cascade){
            const summary = summarizeSubagentGroup(states.map((state, index)=>agent({
                    id: `a${index}`,
                    state
                })));
            expect(summary.settledState).toBe(expected);
        }
    });
    it('counts how many children hold the winning verdict', ()=>{
        const summary = summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'failed'
            }),
            agent({
                id: 'b',
                state: 'failed'
            }),
            agent({
                id: 'c',
                state: 'completed'
            })
        ]);
        expect(summary).toMatchObject({
            settledState: 'failed',
            settledCount: 2
        });
    });
    it('sums the per-child token snapshots and leaves them null when none reported', ()=>{
        expect(summarizeSubagentGroup([
            agent({
                id: 'a',
                tokens: 40661
            }),
            agent({
                id: 'b',
                tokens: 1000
            }),
            agent({
                id: 'c'
            })
        ]).tokens).toBe(41661);
        expect(summarizeSubagentGroup([
            agent({
                id: 'a'
            })
        ]).tokens).toBeNull();
    });
    it('reports the earliest start and withholds a settled time while work continues', ()=>{
        const working = summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'completed',
                startedAt: 50,
                settledAt: 80
            }),
            agent({
                id: 'b',
                state: 'working',
                startedAt: 20
            })
        ]);
        const settled = summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'completed',
                startedAt: 50,
                settledAt: 80
            }),
            agent({
                id: 'b',
                state: 'stopped',
                startedAt: 20,
                settledAt: 95
            })
        ]);
        expect(working).toMatchObject({
            startedAt: 20,
            settledAt: null
        });
        expect(settled).toMatchObject({
            startedAt: 20,
            settledAt: 95
        });
    });
    it('reads a state this build does not know as unverifiable, never as working', ()=>{
        expect(normalizeSubagentState('paused-for-review')).toBe('unverifiable');
        expect(isTerminalSubagentState('paused-for-review')).toBe(true);
        expect(summarizeSubagentGroup([
            agent({
                state: 'unheard-of'
            })
        ])).toMatchObject({
            working: 0,
            settledState: 'unverifiable'
        });
    });
    it('reports an adverse outcome before the group settles', ()=>{
        const summary = summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'working'
            }),
            agent({
                id: 'c',
                state: 'failed'
            })
        ]);
        expect(summary).toMatchObject({
            working: 2,
            settledState: null,
            adverseState: 'failed',
            adverseCount: 1
        });
    });
    it('ranks the adverse outcome worst-first and ignores benign settled states', ()=>{
        expect(summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'stopped'
            }),
            agent({
                id: 'c',
                state: 'failed'
            })
        ]).adverseState).toBe('failed');
        expect(summarizeSubagentGroup([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'idle'
            }),
            agent({
                id: 'c',
                state: 'completed'
            })
        ]).adverseState).toBeNull();
    });
    it('keeps working the only non-terminal state', ()=>{
        expect(isTerminalSubagentState('working')).toBe(false);
        for (const state of [
            'idle',
            'completed',
            'failed',
            'stopped',
            'unverifiable'
        ]){
            expect(isTerminalSubagentState(state)).toBe(true);
        }
    });
});
describe('subagentGroupFallbackText', ()=>{
    it('names the failure a client without the block type would otherwise never see', ()=>{
        expect(subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'working'
            }),
            agent({
                id: 'c',
                state: 'failed'
            })
        ])).toBe('Kicked off 3 subagents (1 failed)');
        expect(subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'completed'
            }),
            agent({
                id: 'b',
                state: 'stopped'
            })
        ])).toBe('Ran 2 subagents (1 stopped)');
    });
    it('makes no liveness claim a replayed row could not still justify', ()=>{
        const inFlight = subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'working'
            }),
            agent({
                id: 'c',
                state: 'completed'
            })
        ]);
        expect(inFlight).toBe('Kicked off 3 subagents');
        expect(inFlight).not.toMatch(/\bworking\b/);
        expect(subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'working'
            }),
            agent({
                id: 'b',
                state: 'unverifiable'
            })
        ])).toBe('Kicked off 2 subagents (1 unverifiable)');
    });
    it('stays quiet when nothing has gone wrong', ()=>{
        expect(subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'working'
            })
        ])).toBe('Kicked off 1 subagent');
        expect(subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'completed'
            })
        ])).toBe('Ran 1 subagent');
    });
});
describe('isSubagentGroupFallbackText', ()=>{
    it('recognizes every sentence the producer writes, including an unknown state', ()=>{
        expect(isSubagentGroupFallbackText(subagentGroupFallbackText([
            agent({})
        ]))).toBe(true);
        expect(isSubagentGroupFallbackText(subagentGroupFallbackText([
            agent({
                id: 'a'
            }),
            agent({
                id: 'b',
                state: 'failed'
            })
        ]))).toBe(true);
        expect(isSubagentGroupFallbackText(subagentGroupFallbackText([
            agent({
                id: 'a',
                state: 'completed'
            })
        ]))).toBe(true);
        expect(isSubagentGroupFallbackText('Ran 2 subagents (1 cancelled)')).toBe(true);
        expect(isSubagentGroupFallbackText('Kicked off 4 subagents — 2 working (1 timed-out)')).toBe(true);
    });
    it('still recognizes the legacy twin already frozen into existing journals', ()=>{
        for (const legacy of [
            'Kicked off 1 subagent — 1 working',
            'Kicked off 4 subagents — 2 working',
            'Kicked off 4 subagents — 2 working (1 failed)',
            'Kicked off 4 subagents — 2 working (1 timed-out)'
        ]){
            expect(isSubagentGroupFallbackText(legacy)).toBe(true);
        }
    });
    it('leaves prose that merely mentions subagents alone', ()=>{
        for (const prose of [
            'Handing the audit to two children.',
            'I kicked off 2 subagents to look at this',
            'Ran 2 subagents and then cleaned up',
            'Ran 2 subagents (1 failed) — see below',
            'Ran two subagents'
        ]){
            expect(isSubagentGroupFallbackText(prose)).toBe(false);
        }
    });
});
