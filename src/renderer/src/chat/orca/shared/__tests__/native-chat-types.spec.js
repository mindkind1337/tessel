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
import { isTextBlock, isToolCallBlock, isToolResultBlock, isImageRefBlock, NATIVE_CHAT_SOURCE_PRIORITY } from "../native-chat-types.js";
const textBlock = {
    type: 'text',
    text: 'hello'
};
const toolCallBlock = {
    type: 'tool-call',
    name: 'Edit',
    input: {
        path: 'a'
    }
};
const toolResultBlock = {
    type: 'tool-result',
    output: 'done',
    isError: false
};
const imageRefBlock = {
    type: 'image-ref',
    path: '/tmp/a.png',
    alt: 'a'
};
describe('native chat block guards', ()=>{
    it('isTextBlock narrows only text blocks', ()=>{
        expect(isTextBlock(textBlock)).toBe(true);
        expect(isTextBlock(toolCallBlock)).toBe(false);
        expect(isTextBlock(toolResultBlock)).toBe(false);
        expect(isTextBlock(imageRefBlock)).toBe(false);
    });
    it('isToolCallBlock narrows only tool-call blocks', ()=>{
        expect(isToolCallBlock(toolCallBlock)).toBe(true);
        expect(isToolCallBlock(textBlock)).toBe(false);
    });
    it('isToolResultBlock narrows only tool-result blocks', ()=>{
        expect(isToolResultBlock(toolResultBlock)).toBe(true);
        expect(isToolResultBlock(toolCallBlock)).toBe(false);
    });
    it('isImageRefBlock narrows only image-ref blocks', ()=>{
        expect(isImageRefBlock(imageRefBlock)).toBe(true);
        expect(isImageRefBlock(textBlock)).toBe(false);
    });
});
describe('source priority', ()=>{
    it('ranks transcript > hook > scrape', ()=>{
        expect(NATIVE_CHAT_SOURCE_PRIORITY.transcript).toBeGreaterThan(NATIVE_CHAT_SOURCE_PRIORITY.hook);
        expect(NATIVE_CHAT_SOURCE_PRIORITY.hook).toBeGreaterThan(NATIVE_CHAT_SOURCE_PRIORITY.scrape);
    });
});
