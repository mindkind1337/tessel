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
import { estimateNativeChatRowHeight, estimateNativeChatTextLines, NATIVE_CHAT_ROW_GAP_PX, nativeChatRowContentMetrics } from "../native-chat-row-height-estimate.js";
const NO_CHROME = {
    hasReceipt: false,
    hasStatus: false,
    hasTurnDiff: false
};
function message(text, role = 'assistant') {
    return {
        id: `m-${text.length}`,
        role,
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
describe('transcript row height estimate', ()=>{
    it('counts hard breaks and soft wraps as separate display lines', ()=>{
        expect(estimateNativeChatTextLines('')).toBe(0);
        expect(estimateNativeChatTextLines('one line')).toBe(1);
        expect(estimateNativeChatTextLines('one\ntwo\nthree')).toBe(3);
        expect(estimateNativeChatTextLines('x'.repeat(300))).toBeGreaterThan(1);
        expect(estimateNativeChatTextLines('a\n\nb')).toBe(3);
    });
    it('grows with the prose it is estimating', ()=>{
        const short = estimateNativeChatRowHeight(nativeChatRowContentMetrics(message('one line')), NO_CHROME);
        const long = estimateNativeChatRowHeight(nativeChatRowContentMetrics(message(Array.from({
            length: 40
        }, ()=>'line').join('\n'))), NO_CHROME);
        expect(long).toBeGreaterThan(short);
    });
    it('bounds the estimate at both ends', ()=>{
        const empty = estimateNativeChatRowHeight(nativeChatRowContentMetrics(message('')), NO_CHROME);
        const enormous = estimateNativeChatRowHeight(nativeChatRowContentMetrics(message('line\n'.repeat(5000))), NO_CHROME);
        expect(empty).toBeGreaterThan(0);
        expect(enormous).toBeLessThan(5000 * 22);
    });
    it('charges a prose row for its lines and for nothing else', ()=>{
        const lines = (count)=>estimateNativeChatRowHeight(nativeChatRowContentMetrics(message(Array.from({
                length: count
            }, ()=>'x').join('\n'))), NO_CHROME);
        const perLine = lines(10) - lines(9);
        expect(perLine).toBeGreaterThan(0);
        expect(lines(10)).toBe(10 * perLine);
    });
    it('charges a row for the gap above a turn status it carries', ()=>{
        const metrics = nativeChatRowContentMetrics(message('one line'));
        const bare = estimateNativeChatRowHeight(metrics, NO_CHROME);
        const withStatus = estimateNativeChatRowHeight(metrics, {
            ...NO_CHROME,
            hasStatus: true
        });
        expect(withStatus - bare).toBeGreaterThan(NATIVE_CHAT_ROW_GAP_PX);
    });
    it('does not add a leading gap to status-only or diff-only rows', ()=>{
        const empty = nativeChatRowContentMetrics(message(''));
        const bare = estimateNativeChatRowHeight(empty, NO_CHROME);
        const statusOnly = estimateNativeChatRowHeight(empty, {
            ...NO_CHROME,
            hasStatus: true
        });
        const diffOnly = estimateNativeChatRowHeight(empty, {
            ...NO_CHROME,
            hasTurnDiff: true
        });
        expect(statusOnly).toBe(diffOnly);
        expect(statusOnly - bare).toBeLessThan(NATIVE_CHAT_ROW_GAP_PX);
    });
    it('includes both rendered parts and their gap for a receipt carrying a diff', ()=>{
        const empty = nativeChatRowContentMetrics(message(''));
        const receipt = estimateNativeChatRowHeight(empty, {
            hasReceipt: true,
            hasStatus: false,
            hasTurnDiff: false
        });
        const diff = estimateNativeChatRowHeight(empty, {
            hasReceipt: false,
            hasStatus: false,
            hasTurnDiff: true
        });
        const together = estimateNativeChatRowHeight(empty, {
            hasReceipt: true,
            hasStatus: false,
            hasTurnDiff: true
        });
        expect(together).toBe(receipt + NATIVE_CHAT_ROW_GAP_PX + diff);
    });
    it('reuses one derivation per message', ()=>{
        const subject = message('cached');
        expect(nativeChatRowContentMetrics(subject)).toBe(nativeChatRowContentMetrics(subject));
    });
    it('keeps role-specific chrome when two messages share their blocks', ()=>{
        const blocks = [
            {
                type: 'text',
                text: 'same content'
            }
        ];
        const withRole = (role)=>({
                ...message('same content', role),
                blocks
            });
        expect(nativeChatRowContentMetrics(withRole('user')).role).toBe('user');
        expect(nativeChatRowContentMetrics(withRole('assistant')).role).toBe('assistant');
    });
    it('reserves more for a row carrying a tool run than for its prose alone', ()=>{
        const prose = nativeChatRowContentMetrics(message('ran something'));
        const withTool = nativeChatRowContentMetrics({
            id: 'tool',
            role: 'assistant',
            blocks: [
                {
                    type: 'text',
                    text: 'ran something'
                },
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
        });
        expect(estimateNativeChatRowHeight(withTool, NO_CHROME)).toBeGreaterThan(estimateNativeChatRowHeight(prose, NO_CHROME));
    });
});
