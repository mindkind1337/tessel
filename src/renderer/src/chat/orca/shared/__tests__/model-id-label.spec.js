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
import { labelFromModelId } from "../model-id-label.js";
describe('labelFromModelId', ()=>{
    it('titlecases hyphenated segments', ()=>{
        expect(labelFromModelId('grok-build')).toBe('Grok Build');
        expect(labelFromModelId('grok')).toBe('Grok');
    });
    it('keeps short numeric segments verbatim', ()=>{
        expect(labelFromModelId('grok-4.5')).toBe('Grok 4.5');
        expect(labelFromModelId('grok-4.5-fast')).toBe('Grok 4.5 Fast');
    });
    it('special-cases the gpt segment', ()=>{
        expect(labelFromModelId('gpt-5.3-codex')).toBe('GPT 5.3 Codex');
        expect(labelFromModelId('GPT-5')).toBe('GPT 5');
    });
    it('splits provider-prefixed ids on the slash', ()=>{
        expect(labelFromModelId('xai/grok-4.5')).toBe('Xai Grok 4.5');
    });
    it('drops empty segments from repeated or edge separators', ()=>{
        expect(labelFromModelId('grok--4.5')).toBe('Grok 4.5');
        expect(labelFromModelId('-grok-')).toBe('Grok');
        expect(labelFromModelId('')).toBe('');
    });
    it('uppercases only digit-led segments of three characters or fewer', ()=>{
        expect(labelFromModelId('grok-4o')).toBe('Grok 4O');
        expect(labelFromModelId('grok-2026.07.19')).toBe('Grok 2026.07.19');
    });
});
