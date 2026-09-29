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
import { hasMoreNativeChatHistory, NATIVE_CHAT_INITIAL_LIMIT, NATIVE_CHAT_PAGE, nextNativeChatLimit } from "../native-chat-pagination.js";
describe('nextNativeChatLimit', ()=>{
    it('grows the limit by one page', ()=>{
        expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT)).toBe(NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE);
        expect(nextNativeChatLimit(NATIVE_CHAT_INITIAL_LIMIT + NATIVE_CHAT_PAGE)).toBe(NATIVE_CHAT_INITIAL_LIMIT + 2 * NATIVE_CHAT_PAGE);
    });
});
describe('hasMoreNativeChatHistory', ()=>{
    it('reports more when the read filled the requested window', ()=>{
        expect(hasMoreNativeChatHistory(300, 300)).toBe(true);
        expect(hasMoreNativeChatHistory(301, 300)).toBe(true);
    });
    it('reports done when the read returned fewer than requested (head reached)', ()=>{
        expect(hasMoreNativeChatHistory(120, 300)).toBe(false);
        expect(hasMoreNativeChatHistory(0, 300)).toBe(false);
    });
});
