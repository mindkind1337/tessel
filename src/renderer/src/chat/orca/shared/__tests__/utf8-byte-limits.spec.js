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
import { clampUtf8TextPrefix, getUtf8ByteLength, getUtf8ChunkEndIndex, isUtf8ByteLengthWithinLimit, measureUtf8ByteLength, readUtf8CodePointAt } from "../utf8-byte-limits.js";
const SLICE_BOUNDARY_PARENT_UNITS = [
    0x72,
    0x2e6,
    0x7b,
    0x54,
    0xda9b,
    0x568,
    0x52,
    0x26,
    0x46,
    0xc15b,
    0x7,
    0x768,
    0xd9f6,
    0xdcde
];
const SLICE_BOUNDARY_UNITS = 13;
const TIER_UP_ITERATIONS = 200_000;
function buildSliceEndingInLoneHighSurrogate() {
    let text = '';
    for (const unit of SLICE_BOUNDARY_PARENT_UNITS){
        text += String.fromCharCode(unit);
    }
    return text.slice(0, SLICE_BOUNDARY_UNITS);
}
describe('scanning a prefix slice whose parent continues past the slice', ()=>{
    const sliced = buildSliceEndingInLoneHighSurrogate();
    it('is a sliced string that ends in a lone high surrogate', ()=>{
        expect(sliced.length).toBe(SLICE_BOUNDARY_UNITS);
        expect(sliced.charCodeAt(SLICE_BOUNDARY_UNITS - 1)).toBe(0xd9f6);
        expect(Buffer.byteLength(sliced, 'utf8')).toBe(22);
    });
    it('reads the trailing lone surrogate without pairing past the end in every JIT tier', ()=>{
        const observed = new Set();
        for(let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1){
            observed.add(readUtf8CodePointAt(sliced, SLICE_BOUNDARY_UNITS - 1));
        }
        expect([
            ...observed
        ]).toEqual([
            0xd9f6
        ]);
    });
    it('measures the same byte length as the encoder in every JIT tier', ()=>{
        const expected = Buffer.byteLength(sliced, 'utf8');
        const observed = new Set();
        for(let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1){
            observed.add(measureUtf8ByteLength(sliced).byteLength);
        }
        expect([
            ...observed
        ]).toEqual([
            expected
        ]);
    });
    it('does not report an exceeded limit at the true byte length in every JIT tier', ()=>{
        const limit = Buffer.byteLength(sliced, 'utf8');
        const observed = new Set();
        for(let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1){
            observed.add(measureUtf8ByteLength(sliced, {
                stopAfterBytes: limit
            }).exceededLimit);
        }
        expect([
            ...observed
        ]).toEqual([
            false
        ]);
    });
    it('keeps the whole slice when clamping to its true byte length in every JIT tier', ()=>{
        const limit = Buffer.byteLength(sliced, 'utf8');
        const observed = new Set();
        for(let iteration = 0; iteration < TIER_UP_ITERATIONS; iteration += 1){
            observed.add(clampUtf8TextPrefix(sliced, limit).length);
        }
        expect([
            ...observed
        ]).toEqual([
            SLICE_BOUNDARY_UNITS
        ]);
    });
});
describe('getUtf8ChunkEndIndex', ()=>{
    it.each([
        {
            name: 'ASCII',
            text: 'abcdef',
            maxBytes: 3,
            endIndex: 3
        },
        {
            name: 'multibyte characters',
            text: 'aé中z',
            maxBytes: 6,
            endIndex: 3
        }
    ])('respects the byte budget for $name', ({ text, maxBytes, endIndex })=>{
        expect(getUtf8ChunkEndIndex(text, 0, maxBytes)).toBe(endIndex);
    });
    it('never splits valid surrogate pairs', ()=>{
        expect(getUtf8ChunkEndIndex('a😀b', 0, 4)).toBe(1);
        expect(getUtf8ChunkEndIndex('a😀b', 1, 4)).toBe(3);
    });
    it.each([
        '\ud800a',
        '\udc00a'
    ])('counts a lone surrogate as three bytes', (text)=>{
        expect(getUtf8ChunkEndIndex(text, 0, 3)).toBe(1);
    });
    it('starts measuring at the requested offset', ()=>{
        expect(getUtf8ChunkEndIndex('skipé中tail', 4, 5)).toBe(6);
    });
    it('returns the starting index when no text remains', ()=>{
        expect(getUtf8ChunkEndIndex('', 0, 1)).toBe(0);
        expect(getUtf8ChunkEndIndex('abc', 3, 1)).toBe(3);
    });
    it.each([
        0,
        -1
    ])('consumes one code point when the %s-byte budget is exceeded', (maxBytes)=>{
        expect(getUtf8ChunkEndIndex('😀a', 0, maxBytes)).toBe(2);
    });
    it('preserves raw non-finite budget comparisons', ()=>{
        expect(getUtf8ChunkEndIndex('abc', 0, Number.NaN)).toBe(3);
        expect(getUtf8ChunkEndIndex('abc', 0, Number.POSITIVE_INFINITY)).toBe(3);
        expect(getUtf8ChunkEndIndex('abc', 0, Number.NEGATIVE_INFINITY)).toBe(1);
    });
});
describe('isUtf8ByteLengthWithinLimit', ()=>{
    it.each([
        {
            name: 'ASCII at a finite limit',
            text: 'abc',
            maxBytes: 3,
            expected: true
        },
        {
            name: 'ASCII over a finite limit',
            text: 'abcd',
            maxBytes: 3,
            expected: false
        },
        {
            name: 'multibyte text at its limit',
            text: 'é中',
            maxBytes: 5,
            expected: true
        },
        {
            name: 'multibyte text over its limit',
            text: 'é中',
            maxBytes: 4,
            expected: false
        },
        {
            name: 'empty text with a negative limit',
            text: '',
            maxBytes: -1,
            expected: true
        },
        {
            name: 'nonempty text with negative infinity',
            text: 'a',
            maxBytes: -Infinity,
            expected: false
        },
        {
            name: 'text with a NaN limit',
            text: '😀',
            maxBytes: Number.NaN,
            expected: true
        },
        {
            name: 'text with positive infinity',
            text: '😀',
            maxBytes: Infinity,
            expected: true
        }
    ])('$name', ({ text, maxBytes, expected })=>{
        expect(isUtf8ByteLengthWithinLimit(text, maxBytes)).toBe(expected);
    });
});
describe('isUtf8ByteLengthWithinLimit native fast path', ()=>{
    const samples = [
        '',
        'a',
        'ascii only text',
        'caf\u00e9',
        '\u20ac\u20ac\u20ac',
        '\ud83d\ude00\ud83d\ude00',
        '\ud83d',
        '\ude00',
        'mixed \u00e9 \u20ac \ud83d\ude00 tail',
        'x'.repeat(64)
    ];
    it('matches the scanning implementation at every limit around the boundary', ()=>{
        for (const text of samples){
            const exactBytes = getUtf8ByteLength(text);
            for(let maxBytes = 1; maxBytes <= exactBytes + 2; maxBytes += 1){
                expect({
                    text,
                    maxBytes,
                    within: isUtf8ByteLengthWithinLimit(text, maxBytes)
                }).toEqual({
                    text,
                    maxBytes,
                    within: text.length <= maxBytes && exactBytes <= maxBytes
                });
            }
        }
    });
});
