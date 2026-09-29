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
import { IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR, imagePasteWritesFollowedByText } from "../image-paste-following-text.js";
const IMAGE_A = '\x1b[200~/tmp/orca-paste-a.png\x1b[201~';
const IMAGE_B = '\x1b[200~/tmp/orca-paste-b.png\x1b[201~';
describe('imagePasteWritesFollowedByText', ()=>{
    it('separates an attachment path from following prompt text by a single space', ()=>{
        expect(imagePasteWritesFollowedByText([
            IMAGE_A
        ], true)).toEqual([
            `${IMAGE_A} `
        ]);
        expect(IMAGE_PASTE_FOLLOWING_TEXT_SEPARATOR).toBe(' ');
    });
    it('keeps an attachment-only send as the framed path with no trailing separator', ()=>{
        expect(imagePasteWritesFollowedByText([
            IMAGE_A
        ], false)).toEqual([
            IMAGE_A
        ]);
    });
    it('returns no writes when there are no image pastes', ()=>{
        expect(imagePasteWritesFollowedByText([], true)).toEqual([]);
    });
    it('keeps back-to-back image frames bare and separates only the final frame from prompt text', ()=>{
        expect(imagePasteWritesFollowedByText([
            IMAGE_A,
            IMAGE_B
        ], true)).toEqual([
            IMAGE_A,
            `${IMAGE_B} `
        ]);
        expect(imagePasteWritesFollowedByText([
            IMAGE_A,
            IMAGE_B
        ], false)).toEqual([
            IMAGE_A,
            IMAGE_B
        ]);
    });
});
