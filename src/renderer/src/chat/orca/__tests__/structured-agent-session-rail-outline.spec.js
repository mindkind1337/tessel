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
import { selectStructuredRailOutline } from "../structured-agent-session-rail-outline.js";
function outline(through, sequences, epoch = 'epoch-1') {
    return {
        sessionId: 'session-1',
        cursor: {
            epoch,
            sequence: through
        },
        entries: sequences.map((sequence)=>({
                itemId: `user-${sequence}`,
                sequence,
                preview: `prompt ${sequence}`,
                imageCount: sequence === 1 ? 2 : 0
            })),
        omittedEntries: 0
    };
}
const WINDOW = {
    epoch: 'epoch-1',
    oldestLoadedSequence: 50,
    hasOlder: true
};
describe('structured rail outline selection', ()=>{
    it('needs no outline when nothing older is unloaded', ()=>{
        expect(selectStructuredRailOutline(outline(90, [
            1,
            60
        ]), {
            ...WINDOW,
            hasOlder: false
        })).toEqual({
            kind: 'complete'
        });
        expect(selectStructuredRailOutline(null, {
            ...WINDOW,
            oldestLoadedSequence: null
        })).toEqual({
            kind: 'complete'
        });
    });
    it('uses only the entries older than the loaded window, which is authoritative for the rest', ()=>{
        const view = selectStructuredRailOutline(outline(90, [
            1,
            20,
            49,
            50,
            70
        ]), WINDOW);
        expect(view).toEqual({
            kind: 'fresh',
            entries: [
                {
                    id: 'user-1',
                    text: 'prompt 1',
                    hasImages: true
                },
                {
                    id: 'user-20',
                    text: 'prompt 20',
                    hasImages: false
                },
                {
                    id: 'user-49',
                    text: 'prompt 49',
                    hasImages: false
                }
            ]
        });
    });
    it('is stale, and so unused, while no outline has arrived', ()=>{
        expect(selectStructuredRailOutline(null, WINDOW)).toEqual({
            kind: 'stale'
        });
    });
    it('is stale across an epoch change', ()=>{
        expect(selectStructuredRailOutline(outline(90, [
            1
        ], 'epoch-0'), WINDOW)).toEqual({
            kind: 'stale'
        });
    });
    it('is stale when the loaded window has moved past what the outline covers', ()=>{
        expect(selectStructuredRailOutline(outline(48, [
            1
        ]), WINDOW)).toEqual({
            kind: 'stale'
        });
        expect(selectStructuredRailOutline(outline(49, [
            1
        ]), WINDOW).kind).toBe('fresh');
    });
    it('hands the rail one entries array until the window edge moves', ()=>{
        const value = outline(90, [
            1,
            20,
            49
        ]);
        const first = selectStructuredRailOutline(value, WINDOW);
        expect(selectStructuredRailOutline(value, {
            ...WINDOW
        })).toBe(first);
        const paged = selectStructuredRailOutline(value, {
            ...WINDOW,
            oldestLoadedSequence: 20
        });
        expect(paged).not.toBe(first);
        expect(paged).toMatchObject({
            kind: 'fresh',
            entries: [
                {
                    id: 'user-1'
                }
            ]
        });
    });
    it('keeps the same entries while a trimmed live window moves its edge past no user message', ()=>{
        const value = outline(200, [
            1,
            20,
            49,
            80
        ]);
        const first = selectStructuredRailOutline(value, WINDOW);
        for (const oldestLoadedSequence of [
            51,
            60,
            80
        ]){
            expect(selectStructuredRailOutline(value, {
                ...WINDOW,
                oldestLoadedSequence
            })).toBe(first);
        }
        const passed = selectStructuredRailOutline(value, {
            ...WINDOW,
            oldestLoadedSequence: 81
        });
        expect(passed).toMatchObject({
            kind: 'fresh',
            entries: [
                {},
                {},
                {},
                {
                    id: 'user-80'
                }
            ]
        });
    });
});
