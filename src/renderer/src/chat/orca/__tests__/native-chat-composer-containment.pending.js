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
import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
const composerField = fs.readFileSync(new URL('./NativeChatComposerField.tsx', import.meta.url), 'utf8');
const autocompleteMenus = fs.readFileSync(new URL('./NativeChatAutocompleteMenus.tsx', import.meta.url), 'utf8');
describe('native chat composer paint containment (#10481)', ()=>{
    it('bounds caret repaints to the composer input shell', ()=>{
        expect(composerField).toContain('[contain:paint]');
    });
    it('keeps the outer composer uncontained so the pickers can overflow it', ()=>{
        const outerShell = composerField.slice(0, composerField.indexOf('[contain:paint]'));
        expect(outerShell).toContain('<div className="shrink-0 bg-background">');
        expect(outerShell).not.toContain('contain:paint');
    });
    it('lifts both pickers above the contained shell', ()=>{
        for (const picker of [
            'bottom-full left-0 right-0 z-20',
            'bottom-full left-3 right-3 z-20'
        ]){
            expect(autocompleteMenus).toContain(picker);
        }
    });
});
