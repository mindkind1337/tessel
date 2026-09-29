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
import { GROK_MODEL_LIST_ARGS, parseGrokModelList } from "../grok-model-list-probe.js";
const SIGNED_IN_STDOUT = [
    'You are logged in with grok.com.',
    '',
    'Default model: grok-4.6',
    '',
    'Available models:',
    '  * grok-4.6 (default)',
    '  - grok-4.5',
    ''
].join('\n');
describe('parseGrokModelList', ()=>{
    it('probes with the only listing subcommand grok exposes', ()=>{
        expect(GROK_MODEL_LIST_ARGS).toEqual([
            'models'
        ]);
    });
    it('parses the signed-in listing into exactly the bulleted models', ()=>{
        expect(parseGrokModelList(SIGNED_IN_STDOUT)).toEqual([
            {
                id: 'grok-4.6',
                label: 'Grok 4.6',
                isDefault: true
            },
            {
                id: 'grok-4.5',
                label: 'Grok 4.5'
            }
        ]);
    });
    it('marks only the row the listing itself annotates', ()=>{
        const parsed = parseGrokModelList('Available models:\n  * grok-build\n  * grok-4.5 (default)\n  * grok-mini\n');
        expect(parsed.map(({ id, isDefault })=>[
                id,
                isDefault
            ])).toEqual([
            [
                'grok-build',
                undefined
            ],
            [
                'grok-4.5',
                true
            ],
            [
                'grok-mini',
                undefined
            ]
        ]);
    });
    it('names no default when the listing annotates none', ()=>{
        const parsed = parseGrokModelList('Available models:\n  * grok-4.5\n  * grok-build\n');
        expect(parsed.every(({ isDefault })=>isDefault === undefined)).toBe(true);
    });
    it('does not treat another parenthetical as the default marker', ()=>{
        const parsed = parseGrokModelList('Available models:\n  * grok-build (beta)\n');
        expect(parsed[0].isDefault).toBeUndefined();
    });
    it('ignores the decoy ids that sit above the header', ()=>{
        const parsed = parseGrokModelList(SIGNED_IN_STDOUT);
        expect(parsed).toHaveLength(2);
        expect(parsed.some(({ id })=>id.includes('grok.com'))).toBe(false);
    });
    it('reads the default marker off a dashed row too', ()=>{
        expect(parseGrokModelList('Available models:\n  - grok-build\n  - grok-4.5 (default)\n').map(({ id, isDefault })=>[
                id,
                isDefault
            ])).toEqual([
            [
                'grok-build',
                undefined
            ],
            [
                'grok-4.5',
                true
            ]
        ]);
    });
    it('strips a trailing parenthetical annotation from the id, spaced or not', ()=>{
        const parsed = parseGrokModelList('Available models:\n  * grok-4.5 (default)\n  * grok-build(beta)\n');
        expect(parsed.map(({ id })=>id)).toEqual([
            'grok-4.5',
            'grok-build'
        ]);
    });
    it('keeps hyphens and dots inside an id', ()=>{
        const parsed = parseGrokModelList('Available models:\n  * grok-4.5-fast-2026.07.19\n');
        expect(parsed).toEqual([
            {
                id: 'grok-4.5-fast-2026.07.19',
                label: 'Grok 4.5 Fast 2026.07.19'
            }
        ]);
    });
    it('parses several models in listing order and deduplicates', ()=>{
        const parsed = parseGrokModelList('Available models:\n  * grok-4.5 (default)\n  * grok-build\n  * grok-4.5\n');
        expect(parsed.map(({ id })=>id)).toEqual([
            'grok-4.5',
            'grok-build'
        ]);
    });
    it('tolerates CRLF line endings', ()=>{
        expect(parseGrokModelList('Available models:\r\n  * grok-4.5 (default)\r\n')).toEqual([
            {
                id: 'grok-4.5',
                label: 'Grok 4.5',
                isDefault: true
            }
        ]);
    });
    it('returns nothing when the header is missing, whatever follows', ()=>{
        expect(parseGrokModelList('Models:\n  * grok-4.5 (default)\n')).toEqual([]);
        expect(parseGrokModelList('Default model: grok-4.5\n')).toEqual([]);
    });
    it('returns nothing for a header with no bullets under it', ()=>{
        expect(parseGrokModelList('Available models:\n')).toEqual([]);
        expect(parseGrokModelList('Available models:\n\n  (none)\n')).toEqual([]);
    });
    it('returns nothing for empty, signed-out, or arbitrary output', ()=>{
        expect(parseGrokModelList('')).toEqual([]);
        expect(parseGrokModelList('\n\n   \n')).toEqual([]);
        expect(parseGrokModelList('You are not logged in. Run `grok login` to continue.\n')).toEqual([]);
        expect(parseGrokModelList("error: unexpected argument '--json' found\n")).toEqual([]);
    });
    it('stops at the blank line that ends the listing section', ()=>{
        expect(parseGrokModelList('Available models:\n  * grok-4.5 (default)\n\nTips:\n  * Set a default with `grok config`\n').map(({ id })=>id)).toEqual([
            'grok-4.5'
        ]);
    });
    it('takes the default marker from a repeated row it would otherwise skip', ()=>{
        expect(parseGrokModelList('Available models:\n  * grok-4.5\n  * grok-4.5 (default)\n')).toEqual([
            {
                id: 'grok-4.5',
                label: 'Grok 4.5',
                isDefault: true
            }
        ]);
    });
    it('still reads a listing whose bullets start after a blank line', ()=>{
        expect(parseGrokModelList('Available models:\n\n  * grok-4.5 (default)\n').map(({ id })=>id)).toEqual([
            'grok-4.5'
        ]);
    });
    it('never emits an entry without both an id and a label', ()=>{
        const stdouts = [
            SIGNED_IN_STDOUT,
            'Available models:\n  * \n  *\n  * grok-4.5\n',
            'Available models:\n  * (default)\n'
        ];
        for (const stdout of stdouts){
            for (const model of parseGrokModelList(stdout)){
                expect(model.id.length).toBeGreaterThan(0);
                expect(model.label.length).toBeGreaterThan(0);
                expect(model.id).not.toMatch(/[\s(]/);
            }
        }
    });
});
