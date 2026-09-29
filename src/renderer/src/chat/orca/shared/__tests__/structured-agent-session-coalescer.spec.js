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
import { createStructuredAgentSessionEventCoalescer } from "../structured-agent-session-coalescer.js";
function batch(sequence, backgroundTasks, activity) {
    return {
        type: 'batch',
        sessionId: 'session-1',
        batch: {
            cursor: {
                epoch: 'epoch-1',
                sequence
            },
            items: [],
            removedItemIds: [],
            submissions: []
        },
        ...backgroundTasks !== undefined ? {
            backgroundTasks
        } : {},
        ...activity !== undefined ? {
            activity
        } : {}
    };
}
describe('structured agent session event coalescer', ()=>{
    it('preserves background task state when a journal batch follows it', ()=>{
        const events = [];
        const coalescer = createStructuredAgentSessionEventCoalescer((event)=>events.push(event));
        coalescer.push(batch(1, {
            state: 'monitoring',
            tasks: [
                {
                    id: 'task-1',
                    kind: 'command',
                    description: 'run the build'
                }
            ]
        }));
        coalescer.push(batch(2));
        coalescer.flush();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            backgroundTasks: {
                state: 'monitoring',
                tasks: [
                    {
                        id: 'task-1',
                        kind: 'command',
                        description: 'run the build'
                    }
                ]
            }
        });
    });
    it('keeps an explicit terminal state as the newest coalesced value', ()=>{
        const events = [];
        const coalescer = createStructuredAgentSessionEventCoalescer((event)=>events.push(event));
        coalescer.push(batch(1, {
            state: 'monitoring'
        }));
        coalescer.push(batch(1, null));
        coalescer.flush();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            backgroundTasks: null
        });
    });
    it('keeps only the latest ephemeral activity value', ()=>{
        const events = [];
        const coalescer = createStructuredAgentSessionEventCoalescer((event)=>events.push(event));
        coalescer.push(batch(1, undefined, {
            turnId: 'turn-1',
            text: 'Thinking'
        }));
        coalescer.push(batch(1, undefined, {
            turnId: 'turn-1',
            text: 'Checking the result'
        }));
        coalescer.push(batch(1, undefined, null));
        coalescer.flush();
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
            activity: null
        });
    });
});
