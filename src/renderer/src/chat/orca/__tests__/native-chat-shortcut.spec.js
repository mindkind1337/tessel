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
import { describe, it, expect } from 'vitest';
import { matchesNativeChatToggleShortcut, nativeChatToggleShortcutLabel } from "../native-chat-shortcut.js";
function combo(overrides) {
    return {
        key: 'j',
        metaKey: false,
        ctrlKey: false,
        shiftKey: false,
        altKey: false,
        ...overrides
    };
}
describe('nativeChatToggleShortcutLabel', ()=>{
    it('uses Cmd/Shift glyphs on Mac', ()=>{
        expect(nativeChatToggleShortcutLabel(true)).toBe('⌘⇧J');
    });
    it('uses Ctrl+/Shift+ text elsewhere', ()=>{
        expect(nativeChatToggleShortcutLabel(false)).toBe('Ctrl+Shift+J');
    });
});
describe('matchesNativeChatToggleShortcut', ()=>{
    it('matches Cmd+Shift+J on Mac', ()=>{
        expect(matchesNativeChatToggleShortcut(combo({
            metaKey: true,
            shiftKey: true
        }), true)).toBe(true);
    });
    it('does not match Ctrl+Shift+J on Mac (wrong primary modifier)', ()=>{
        expect(matchesNativeChatToggleShortcut(combo({
            ctrlKey: true,
            shiftKey: true
        }), true)).toBe(false);
    });
    it('matches Ctrl+Shift+J on Windows/Linux', ()=>{
        expect(matchesNativeChatToggleShortcut(combo({
            ctrlKey: true,
            shiftKey: true
        }), false)).toBe(true);
    });
    it('requires the shift modifier', ()=>{
        expect(matchesNativeChatToggleShortcut(combo({
            metaKey: true
        }), true)).toBe(false);
    });
    it('rejects when alt is held', ()=>{
        expect(matchesNativeChatToggleShortcut(combo({
            metaKey: true,
            shiftKey: true,
            altKey: true
        }), true)).toBe(false);
    });
    it('rejects a different key', ()=>{
        expect(matchesNativeChatToggleShortcut(combo({
            key: 'k',
            metaKey: true,
            shiftKey: true
        }), true)).toBe(false);
    });
});
