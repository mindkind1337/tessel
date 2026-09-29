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
import { fileURLToPath } from 'node:url';
import { formatAgentImagePath } from "../agent-image-paste.js";
describe('OMP image references', ()=>{
    it.each([
        [
            '/tmp/screen@2x.png',
            '@"/tmp/screen@2x.png"'
        ],
        [
            '/tmp/a "quote".png',
            `@'/tmp/a "quote".png'`
        ],
        [
            "/tmp/a 'quote'.png",
            `@"/tmp/a 'quote'.png"`
        ],
        [
            'C:\\Images\\screen shot.png',
            '@"C:\\Images\\screen shot.png"'
        ]
    ])('quotes %s for file-mention parsing', (path, expected)=>{
        expect(formatAgentImagePath('omp', path)).toBe(expected);
        expect(formatAgentImagePath('claude', path)).toBe(path);
    });
    it.each([
        `/tmp/a "both' quotes.png`,
        `/tmp/a "both' quotes/image.png`,
        `/tmp/a "both' @quotes#100%.png`,
        `/tmp/a "both' \\quotes.png`,
        `C:\\Images\\a "both' quotes.png`,
        `\\\\server\\share\\a "both' quotes.png`
    ])('round trips unquotable absolute paths through OMP file URLs: %s', (path)=>{
        const mention = formatAgentImagePath('omp', path);
        const encodedPath = /^@"([^"]+)"$/.exec(mention)?.[1];
        expect(encodedPath).toBeDefined();
        expect(fileURLToPath(encodedPath, {
            windows: !path.startsWith('/')
        })).toBe(path);
        expect(formatAgentImagePath('claude', path)).toBe(path);
    });
});
