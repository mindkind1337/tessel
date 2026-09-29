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
import { deriveNativeChatCanSend, shouldChatTakeOverMobileSurface } from "../native-chat-send-eligibility.js";
describe('deriveNativeChatCanSend', ()=>{
    it('blocks sends when a mobile client holds the pty (presence-lock active)', ()=>{
        expect(deriveNativeChatCanSend({
            kind: 'mobile',
            clientId: 'phone-1'
        })).toBe(false);
    });
    it('allows sends when the desktop drives the pty', ()=>{
        expect(deriveNativeChatCanSend({
            kind: 'desktop'
        })).toBe(true);
    });
    it('allows sends when the pty is idle', ()=>{
        expect(deriveNativeChatCanSend({
            kind: 'idle'
        })).toBe(true);
    });
    it('treats an unresolved driver (null/undefined) as unlocked', ()=>{
        expect(deriveNativeChatCanSend(null)).toBe(true);
        expect(deriveNativeChatCanSend(undefined)).toBe(true);
    });
});
describe('shouldChatTakeOverMobileSurface', ()=>{
    it('takes over the mobile surface when the tab is in chat view', ()=>{
        expect(shouldChatTakeOverMobileSurface('chat')).toBe(true);
    });
    it('leaves the terminal mobile overlay in place in terminal view', ()=>{
        expect(shouldChatTakeOverMobileSurface('terminal')).toBe(false);
    });
});
