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
import { assertJsonTextStructureWithinLimits, JsonTextStructureCapacityError } from "../json-text-structure-limit.js";
describe('JSON text structure admission', ()=>{
    it('preserves exact token and nesting boundaries', ()=>{
        expect(()=>assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
                structuralTokens: 7,
                nestingDepth: 3
            })).not.toThrow();
    });
    it('rejects token and nesting limit +1', ()=>{
        expect(()=>assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
                structuralTokens: 6,
                nestingDepth: 3
            })).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 6));
        expect(()=>assertJsonTextStructureWithinLimits('{"rows":[{}]}', {
                structuralTokens: 7,
                nestingDepth: 2
            })).toThrowError(new JsonTextStructureCapacityError('nestingDepth', 2));
    });
    it('does not count escaped structural characters inside strings', ()=>{
        expect(()=>assertJsonTextStructureWithinLimits('{"value":"[{\\\":,}]"}', {
                structuralTokens: 3,
                nestingDepth: 1
            })).not.toThrow();
    });
    it.each([
        0,
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8,
        9
    ])('handles a quote preceded by %i backslashes', (count)=>{
        const content = `"${'\\'.repeat(count)}"[[]]`;
        const check = ()=>assertJsonTextStructureWithinLimits(content, {
                structuralTokens: 3,
                nestingDepth: 2
            });
        if (count % 2 === 0) {
            expect(check).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 3));
        } else {
            expect(check).not.toThrow();
        }
    });
    it('resumes counting after escaped quotes and long string values', ()=>{
        const content = JSON.stringify({
            value: 'ordinary text [{,}] \\" '.repeat(10_000),
            next: []
        });
        expect(()=>assertJsonTextStructureWithinLimits(content, {
                structuralTokens: 7,
                nestingDepth: 2
            })).not.toThrow();
        expect(()=>assertJsonTextStructureWithinLimits(content, {
                structuralTokens: 6,
                nestingDepth: 2
            })).toThrowError(new JsonTextStructureCapacityError('structuralTokens', 6));
    });
});
