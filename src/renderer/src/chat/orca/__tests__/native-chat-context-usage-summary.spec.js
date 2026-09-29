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
import { formatContextTokenCount, summarizeContextUsage } from "../native-chat-context-usage-summary.js";
describe('summarizeContextUsage', ()=>{
    it('lists every non-empty CLI category, deferred ones included, largest first', ()=>{
        const summary = summarizeContextUsage({
            usedTokens: 29_400,
            windowTokens: 200_000,
            percentage: 15,
            estimated: false,
            categories: [
                {
                    name: 'Messages',
                    tokens: 10_200
                },
                {
                    name: 'System tools (deferred)',
                    tokens: 17_600,
                    deferred: true
                },
                {
                    name: 'Skills',
                    tokens: 0
                },
                {
                    name: 'Free space',
                    tokens: 170_600
                },
                {
                    name: 'System prompt',
                    tokens: 3_800
                }
            ]
        });
        expect(summary.rows).toEqual([
            {
                name: 'Free space',
                tokens: 170_600,
                percentage: 85.3
            },
            {
                name: 'System tools (deferred)',
                tokens: 17_600,
                percentage: 8.8
            },
            {
                name: 'Messages',
                tokens: 10_200,
                percentage: 5.1
            },
            {
                name: 'System prompt',
                tokens: 3_800,
                percentage: 1.9
            }
        ]);
        expect(summary.estimated).toBe(false);
    });
});
describe('formatContextTokenCount', ()=>{
    it('keeps k for thousands and writes millions with a capital M', ()=>{
        expect(formatContextTokenCount(10)).toBe('10');
        expect(formatContextTokenCount(18_600)).toBe('18.6k');
        expect(formatContextTokenCount(200_000)).toBe('200k');
        expect(formatContextTokenCount(981_400)).toBe('981.4k');
        expect(formatContextTokenCount(999_960)).toBe('1M');
        expect(formatContextTokenCount(1_000_000)).toBe('1M');
        expect(formatContextTokenCount(1_500_000)).toBe('1.5M');
        expect(formatContextTokenCount(-5)).toBe('0');
    });
});
