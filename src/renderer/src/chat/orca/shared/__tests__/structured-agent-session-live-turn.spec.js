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
import { statusStructuredAgentSessionToolCall, isStructuredAgentSessionThinking } from "../structured-agent-session-live-turn.js";
function item(itemId, sequence, body) {
    return {
        itemId,
        sequence,
        revision: 1,
        observedAt: sequence,
        body
    };
}
describe('isStructuredAgentSessionThinking', ()=>{
    const turnStart = item('turn-start', 1, {
        kind: 'status',
        text: 'Working',
        turnLifecycle: {
            turnId: 'turn-1',
            state: 'running'
        }
    });
    const reasoning = (sequence)=>item(`reasoning-${sequence}`, sequence, {
            kind: 'message',
            role: 'reasoning',
            blocks: [
                {
                    type: 'text',
                    text: 'Weighing two approaches'
                }
            ]
        });
    it('is true while reasoning is the newest thing the turn produced', ()=>{
        expect(isStructuredAgentSessionThinking([
            turnStart,
            reasoning(2)
        ])).toBe(true);
    });
    it('is false once a tool call, a message or a diff lands after the reasoning', ()=>{
        const after = (body)=>isStructuredAgentSessionThinking([
                turnStart,
                reasoning(2),
                item('after', 3, body)
            ]);
        expect(after({
            kind: 'tool-call',
            name: 'shell',
            input: null,
            state: 'running'
        })).toBe(false);
        expect(after({
            kind: 'message',
            role: 'assistant',
            blocks: [
                {
                    type: 'text',
                    text: 'Here you go'
                }
            ]
        })).toBe(false);
        expect(after({
            kind: 'diff',
            path: 'src/a.ts',
            patch: {
                head: '@@',
                byteLength: 2,
                digest: 'd',
                truncated: false
            }
        })).toBe(false);
    });
    it('is false when a turn produced no reasoning at all', ()=>{
        expect(isStructuredAgentSessionThinking([
            turnStart
        ])).toBe(false);
        expect(isStructuredAgentSessionThinking([])).toBe(false);
    });
    it('does not read an earlier turn as this one reasoning', ()=>{
        const newTurn = item('turn-2-start', 2, {
            kind: 'status',
            text: 'Working',
            turnLifecycle: {
                turnId: 'turn-2',
                state: 'running'
            }
        });
        expect(isStructuredAgentSessionThinking([
            reasoning(1),
            newTurn
        ])).toBe(false);
    });
    it('does not read a completed turn as reasoning during the next pending dispatch', ()=>{
        const completedTurn = item('turn-1', 1, {
            kind: 'turn',
            turnId: 'turn-1',
            state: 'completed'
        });
        expect(isStructuredAgentSessionThinking([
            completedTurn,
            reasoning(2)
        ])).toBe(false);
    });
    it('stops at a typed turn item, the carrier this host writes', ()=>{
        const typedTurn = (sequence, turnId)=>item(`turn-${turnId}`, sequence, {
                kind: 'turn',
                turnId,
                state: 'running'
            });
        expect(isStructuredAgentSessionThinking([
            typedTurn(1, 'turn-1'),
            reasoning(2)
        ])).toBe(true);
        expect(isStructuredAgentSessionThinking([
            reasoning(1),
            typedTurn(2, 'turn-2')
        ])).toBe(false);
    });
    it('lets an unmarked status stay transparent to the latest reasoning state', ()=>{
        const plan = item('plan', 3, {
            kind: 'status',
            text: 'Step 1. Read the file'
        });
        expect(isStructuredAgentSessionThinking([
            turnStart,
            plan
        ])).toBe(false);
        expect(isStructuredAgentSessionThinking([
            turnStart,
            reasoning(2),
            plan
        ])).toBe(true);
    });
    it.each([
        {
            kind: 'approval',
            title: 'Run the command?',
            detail: null,
            options: [],
            resolution: {
                state: 'pending',
                selectedOptionId: null,
                resolvedBy: null,
                resolvedAt: null
            }
        },
        {
            kind: 'question',
            question: 'Which path?',
            options: [],
            resolution: {
                state: 'pending',
                selectedOptionId: null,
                resolvedBy: null,
                resolvedAt: null
            }
        }
    ])('stops thinking when the turn is waiting on a $kind', (prompt)=>{
        expect(isStructuredAgentSessionThinking([
            turnStart,
            reasoning(2),
            item('prompt', 3, prompt)
        ])).toBe(false);
    });
});
describe("the live-turn readers answer for the session's own agent", ()=>{
    const turnStart = item('turn-start', 1, {
        kind: 'status',
        text: 'Working',
        turnLifecycle: {
            turnId: 'turn-1',
            state: 'running'
        }
    });
    const spawnCall = item('root-task', 2, {
        kind: 'tool-call',
        name: 'Task',
        input: {
            description: 'explore'
        },
        state: 'running'
    });
    const child = (itemId, sequence, body, agentId = 'task-1')=>({
            ...item(itemId, sequence, body),
            agentId
        });
    it('does not report the parent as thinking because a subagent is reasoning', ()=>{
        const childReasoning = child('child-reasoning', 3, {
            kind: 'message',
            role: 'reasoning',
            blocks: [
                {
                    type: 'text',
                    text: 'Weighing two approaches'
                }
            ]
        });
        expect(isStructuredAgentSessionThinking([
            turnStart,
            spawnCall,
            childReasoning
        ])).toBe(false);
    });
    it('still reports the parent as thinking when the parent itself is reasoning', ()=>{
        const ownReasoning = item('own-reasoning', 3, {
            kind: 'message',
            role: 'reasoning',
            blocks: [
                {
                    type: 'text',
                    text: 'Weighing two approaches'
                }
            ]
        });
        expect(isStructuredAgentSessionThinking([
            turnStart,
            spawnCall,
            ownReasoning
        ])).toBe(true);
    });
    it("reports the parent's own running call while a subagent runs its own", ()=>{
        const childCall = child('child-grep', 3, {
            kind: 'tool-call',
            name: 'Grep',
            input: {
                pattern: 'x'
            },
            state: 'running'
        });
        expect(statusStructuredAgentSessionToolCall([
            turnStart,
            spawnCall,
            childCall
        ])?.name).toBe('Task');
    });
    it('reports nothing running when only a subagent has a live call', ()=>{
        const childCall = child('child-grep', 2, {
            kind: 'tool-call',
            name: 'Grep',
            input: {
                pattern: 'x'
            },
            state: 'running'
        });
        expect(statusStructuredAgentSessionToolCall([
            turnStart,
            childCall
        ])).toBeNull();
    });
    it('treats an agent id that failed to resolve as a child, not as the parent', ()=>{
        const unresolved = child('child-grep', 3, {
            kind: 'tool-call',
            name: 'Grep',
            input: {
                pattern: 'x'
            },
            state: 'running'
        }, '');
        expect(statusStructuredAgentSessionToolCall([
            turnStart,
            spawnCall,
            unresolved
        ])?.name).toBe('Task');
    });
    it("reads a row written before linkage existed as the parent's own", ()=>{
        const legacyChildCall = item('legacy-call', 3, {
            kind: 'tool-call',
            name: 'Grep',
            input: {
                pattern: 'x'
            },
            state: 'running'
        });
        expect(statusStructuredAgentSessionToolCall([
            turnStart,
            spawnCall,
            legacyChildCall
        ])?.name).toBe('Grep');
    });
});
