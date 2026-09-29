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
import { beforeEach, describe, expect, it } from 'vitest';
import { countLeadingPendingTextsGluedToUserText } from "../native-chat-pending-occurrence.js";
import { appendPendingSendCache, clearPendingSendCacheForTests, pendingSendsAsMessages, prunePendingSends } from "../native-chat-pending.js";
const scope = {
    paneKey: 'tab:leaf',
    agent: 'codex'
};
function message(id, role, text, timestamp) {
    return {
        id,
        role,
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp,
        source: 'transcript'
    };
}
describe('pending send occurrence reconciliation', ()=>{
    beforeEach(()=>clearPendingSendCacheForTests());
    it('keeps the next identical echo after pruning an earlier occurrence', ()=>{
        const first = appendPendingSendCache(scope, {
            id: 'p1',
            text: 'repeat',
            sentAt: 100,
            afterMessageId: 'paged-out-boundary'
        });
        const repeated = appendPendingSendCache(scope, {
            id: 'p2',
            text: 'repeat',
            sentAt: 200,
            afterMessageId: 'paged-out-boundary'
        });
        expect(first[0]?.matchingOccurrence).toBeUndefined();
        expect(repeated[1]).toMatchObject({
            matchingOccurrence: 2,
            matchingAfterTimestamp: 100
        });
        const firstCompletedTurn = [
            message('u1', 'user', 'repeat', 150),
            message('a1', 'assistant', 'done', 160)
        ];
        const afterFirstPrune = prunePendingSends(repeated, firstCompletedTurn);
        expect(afterFirstPrune.map((entry)=>entry.id)).toEqual([
            'p2'
        ]);
        expect(pendingSendsAsMessages(afterFirstPrune, firstCompletedTurn).map((entry)=>entry.id)).toEqual([
            'pending:p2'
        ]);
        const secondCompletedTurn = [
            ...firstCompletedTurn,
            message('u2', 'user', 'repeat', 250),
            message('a2', 'assistant', 'done again', 260)
        ];
        expect(pendingSendsAsMessages(afterFirstPrune, secondCompletedTurn)).toEqual([]);
        expect(prunePendingSends(afterFirstPrune, secondCompletedTurn)).toEqual([]);
    });
});
describe('countLeadingPendingTextsGluedToUserText', ()=>{
    it('consumes a leading run with or without one separator per boundary', ()=>{
        expect(countLeadingPendingTextsGluedToUserText([
            'joke',
            'continue'
        ], 'jokecontinue')).toBe(2);
        expect(countLeadingPendingTextsGluedToUserText([
            'joke',
            'continue'
        ], 'joke continue')).toBe(2);
        expect(countLeadingPendingTextsGluedToUserText([
            'a',
            'b',
            'c'
        ], 'ab c')).toBe(3);
    });
    it('stops at the first prompt that does not continue the row', ()=>{
        expect(countLeadingPendingTextsGluedToUserText([
            'hi'
        ], 'history')).toBe(0);
        expect(countLeadingPendingTextsGluedToUserText([
            'hi',
            'story'
        ], 'hi story continued')).toBe(0);
        expect(countLeadingPendingTextsGluedToUserText([
            'hi',
            'there friend'
        ], 'hi there')).toBe(0);
        expect(countLeadingPendingTextsGluedToUserText([
            'hi',
            'x'
        ], 'hi  x')).toBe(0);
    });
    it('requires the first prompt to start the row', ()=>{
        expect(countLeadingPendingTextsGluedToUserText([
            'hi',
            'there'
        ], ' hi there')).toBe(0);
    });
    it('returns the run length, leaving later prompts to the next row', ()=>{
        expect(countLeadingPendingTextsGluedToUserText([
            'a',
            'b',
            'c'
        ], 'a b')).toBe(2);
    });
    it('rejects empty inputs and empty prompts', ()=>{
        expect(countLeadingPendingTextsGluedToUserText([], 'anything')).toBe(0);
        expect(countLeadingPendingTextsGluedToUserText([
            'a'
        ], '')).toBe(0);
        expect(countLeadingPendingTextsGluedToUserText([
            'a',
            '',
            'b'
        ], 'ab')).toBe(0);
    });
});
describe('pending sends typed through an agent TUI', ()=>{
    beforeEach(()=>clearPendingSendCacheForTests());
    const COMPOSER_TEXT = 'summarize the failing test and propose a fix';
    it('prunes the echo of a row carrying the clear byte', ()=>{
        const pending = appendPendingSendCache(scope, {
            id: 'p1',
            text: COMPOSER_TEXT,
            sentAt: 100,
            afterMessageId: 'boundary'
        });
        const transcript = [
            message('u1', 'user', `\u0015${COMPOSER_TEXT}`, 150),
            message('a1', 'assistant', 'done', 160)
        ];
        expect(prunePendingSends(pending, transcript)).toEqual([]);
        expect(pendingSendsAsMessages(pending, transcript)).toEqual([]);
    });
});
