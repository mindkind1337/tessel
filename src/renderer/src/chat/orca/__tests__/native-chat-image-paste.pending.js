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
import { getAgentImageHandling, isNativeChatPastedImagePath } from "../native-chat-image-paste.js";
describe('image paste agent map', ()=>{
    it('vision-capable TUIs take image attachments', ()=>{
        expect(getAgentImageHandling('claude')).toBe('attachment');
        expect(getAgentImageHandling('codex')).toBe('attachment');
        expect(getAgentImageHandling('grok')).toBe('attachment');
    });
    it('unknown/custom agent is unsupported', ()=>{
        expect(getAgentImageHandling('some-custom-agent')).toBe('unsupported');
    });
});
describe('isNativeChatPastedImagePath', ()=>{
    it('detects clipboard-paste temp files (so the chip shows a friendly label)', ()=>{
        expect(isNativeChatPastedImagePath('/var/folders/x/orca-paste-1782775228480-c9a3c86b-1234-5678-9abc-def012345678.png')).toBe(true);
        expect(isNativeChatPastedImagePath('C:\\Temp\\orca-paste-1-2.png')).toBe(true);
    });
    it('leaves picked/dropped files showing their real name', ()=>{
        expect(isNativeChatPastedImagePath('/Users/me/Pictures/hero-image-2.png')).toBe(false);
        expect(isNativeChatPastedImagePath('/tmp/screenshot.png')).toBe(false);
    });
});
