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
import { matchNativeChatSplitShortcut } from "../native-chat-split-shortcut.js";
describe('matchNativeChatSplitShortcut', ()=>{
    it('uses the existing platform split bindings', ()=>{
        expect(matchNativeChatSplitShortcut({
            key: 'd',
            metaKey: true,
            ctrlKey: false,
            altKey: false,
            shiftKey: false
        }, 'darwin', {})).toBe('right');
        expect(matchNativeChatSplitShortcut({
            key: 'd',
            metaKey: false,
            ctrlKey: true,
            altKey: false,
            shiftKey: true
        }, 'win32', {})).toBe('right');
        expect(matchNativeChatSplitShortcut({
            key: 'd',
            metaKey: false,
            ctrlKey: false,
            altKey: true,
            shiftKey: true
        }, 'linux', {})).toBe('down');
    });
    it('respects customized bindings', ()=>{
        expect(matchNativeChatSplitShortcut({
            key: 'ArrowRight',
            metaKey: false,
            ctrlKey: true,
            altKey: true,
            shiftKey: false
        }, 'linux', {
            'terminal.splitRight': [
                'Ctrl+Alt+Right'
            ]
        })).toBe('right');
    });
});
