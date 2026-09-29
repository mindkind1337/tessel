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
import { backgroundTaskFallbackText, canReplaceBackgroundTaskState, claimBackgroundTaskTwins, isSettledBackgroundTaskState, normalizeBackgroundTaskState } from "../native-chat-background-task-row.js";
function task(overrides = {}) {
    return {
        type: 'background-task',
        taskId: 'task-1',
        kind: 'command',
        label: 'sleep 20',
        state: 'working',
        ...overrides
    };
}
describe('background task row text', ()=>{
    it('leads with the provider sentence — the only account of the failure it ever gave', ()=>{
        expect(backgroundTaskFallbackText(task({
            state: 'blocked',
            summary: 'Background command "X" failed with exit code 1'
        }))).toBe('Background command "X" failed with exit code 1');
    });
    it('falls back to the provider error when no summary arrived', ()=>{
        expect(backgroundTaskFallbackText(task({
            state: 'blocked',
            error: 'ENOENT'
        }))).toBe('ENOENT');
    });
    it('claims only that a live task was started, never that it is still running', ()=>{
        expect(backgroundTaskFallbackText(task())).toBe('Started background command "sleep 20"');
        expect(backgroundTaskFallbackText(task())).not.toContain('running');
    });
    it('names the outcome for a settled task with no provider sentence', ()=>{
        expect(backgroundTaskFallbackText(task({
            state: 'done'
        }))).toBe('Background command "sleep 20" finished');
        expect(backgroundTaskFallbackText(task({
            state: 'unverifiable'
        }))).toBe('Background command "sleep 20" stopped reporting');
    });
    it('falls through to the kind when the provider named nothing', ()=>{
        expect(backgroundTaskFallbackText(task({
            label: '  ',
            state: 'done'
        }))).toBe('Background command finished');
    });
});
describe('background task row state', ()=>{
    it('reads a state this build has no word for as unverifiable, never as live', ()=>{
        expect(normalizeBackgroundTaskState('teleported')).toBe('unverifiable');
        expect(isSettledBackgroundTaskState('teleported')).toBe(true);
        expect(isSettledBackgroundTaskState('waiting')).toBe(false);
    });
    it('latches a reported outcome but lets a real verdict correct lost contact', ()=>{
        expect(canReplaceBackgroundTaskState('working', 'blocked')).toBe(true);
        expect(canReplaceBackgroundTaskState('blocked', 'working')).toBe(false);
        expect(canReplaceBackgroundTaskState('done', 'blocked')).toBe(false);
        expect(canReplaceBackgroundTaskState('unverifiable', 'done')).toBe(true);
        expect(canReplaceBackgroundTaskState('unverifiable', 'working')).toBe(false);
    });
});
describe('background task twins', ()=>{
    it('pairs each row with the frozen sentence written beside it', ()=>{
        const row = task({
            state: 'blocked',
            summary: 'it failed'
        });
        const blocks = [
            {
                type: 'text',
                text: 'it failed'
            },
            row
        ];
        const claims = claimBackgroundTaskTwins(blocks);
        expect([
            ...claims.twinTextIndexes
        ]).toEqual([
            0
        ]);
        expect(claims.unpairedRows.size).toBe(0);
    });
    it('leaves real prose beside a row alone', ()=>{
        const row = task({
            state: 'blocked',
            summary: 'it failed'
        });
        const blocks = [
            {
                type: 'text',
                text: 'here is what I found'
            },
            {
                type: 'text',
                text: 'it failed'
            },
            row
        ];
        expect([
            ...claimBackgroundTaskTwins(blocks).twinTextIndexes
        ]).toEqual([
            1
        ]);
    });
    it('makes a row with no twin print its own sentence rather than nothing', ()=>{
        const row = task({
            state: 'blocked',
            summary: 'it failed'
        });
        const claims = claimBackgroundTaskTwins([
            row
        ]);
        expect(claims.unpairedRows.get(0)).toBe('it failed');
    });
    it('gives two rows sharing a sentence one twin each', ()=>{
        const rows = [
            task({
                taskId: 'a',
                state: 'done'
            }),
            task({
                taskId: 'b',
                state: 'done'
            })
        ];
        const blocks = [
            {
                type: 'text',
                text: 'Background command "sleep 20" finished'
            },
            {
                type: 'text',
                text: 'Background command "sleep 20" finished'
            },
            ...rows
        ];
        const claims = claimBackgroundTaskTwins(blocks);
        expect([
            ...claims.twinTextIndexes
        ]).toEqual([
            0,
            1
        ]);
        expect(claims.unpairedRows.size).toBe(0);
    });
});
