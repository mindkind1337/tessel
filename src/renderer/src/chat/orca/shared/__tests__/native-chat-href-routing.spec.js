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
import { createNativeChatFileHref, routeNativeChatHref } from "../native-chat-href-routing.js";
describe('routeNativeChatHref', ()=>{
    it('classifies web and mail links', ()=>{
        expect(routeNativeChatHref('https://example.com/docs')).toEqual({
            kind: 'web',
            url: 'https://example.com/docs'
        });
        expect(routeNativeChatHref(' mailto:dev@example.com ')).toEqual({
            kind: 'web',
            url: 'mailto:dev@example.com'
        });
    });
    it('parses relative file hrefs and line fragments', ()=>{
        expect(routeNativeChatHref('docs/plan.md?plain=1#line-7')).toEqual({
            kind: 'file',
            pathText: 'docs/plan.md',
            line: 7
        });
        expect(routeNativeChatHref('docs/plan.md#usage')).toEqual({
            kind: 'file',
            pathText: 'docs/plan.md',
            line: null
        });
    });
    it('decodes relative and file URI paths', ()=>{
        expect(routeNativeChatHref('docs/release%20notes.md')).toEqual({
            kind: 'file',
            pathText: 'docs/release notes.md',
            line: null
        });
        expect(routeNativeChatHref('file:///Users/me/wt/My%20File.tsx#L12')).toEqual({
            kind: 'file',
            pathText: '/Users/me/wt/My File.tsx',
            line: 12
        });
    });
    it('keeps Windows drive paths out of the scheme filter', ()=>{
        expect(routeNativeChatHref(String.raw`C:\repo\src\index.ts`)).toEqual({
            kind: 'file',
            pathText: String.raw`C:\repo\src\index.ts`,
            line: null
        });
    });
    it('routes encoded renderer file targets without treating Windows drives as schemes', ()=>{
        expect(routeNativeChatHref(createNativeChatFileHref(String.raw`C:\repo\report.docx:12`))).toEqual({
            kind: 'file',
            pathText: String.raw`C:\repo\report.docx:12`,
            line: null
        });
        expect(routeNativeChatHref(createNativeChatFileHref('/tmp/report.html'))).toEqual({
            kind: 'file',
            pathText: '/tmp/report.html',
            line: null
        });
    });
    it('bounds nested renderer file target decoding', ()=>{
        let href = '/tmp/report.html';
        for(let depth = 0; depth < 4; depth += 1){
            href = createNativeChatFileHref(` ${href}`);
        }
        expect(routeNativeChatHref(href)).toEqual({
            kind: 'file',
            pathText: '/tmp/report.html',
            line: null
        });
        expect(routeNativeChatHref(createNativeChatFileHref(` ${href}`))).toEqual({
            kind: 'none'
        });
    });
    it('keeps wrapped location text literal', ()=>{
        expect(routeNativeChatHref(createNativeChatFileHref('My C# App/Program.cs'))).toEqual({
            kind: 'file',
            pathText: 'My C# App/Program.cs',
            line: null
        });
        expect(routeNativeChatHref(createNativeChatFileHref('assets/icon%20big.png?v'))).toEqual({
            kind: 'file',
            pathText: 'assets/icon%20big.png?v',
            line: null
        });
    });
    it('reads a bare file name with a line suffix as a file, not a scheme', ()=>{
        expect(routeNativeChatHref('README.md:5')).toEqual({
            kind: 'file',
            pathText: 'README.md:5',
            line: null
        });
        expect(routeNativeChatHref('App.tsx:12:3')).toEqual({
            kind: 'file',
            pathText: 'App.tsx:12:3',
            line: null
        });
        expect(routeNativeChatHref('localhost:3000')).toEqual({
            kind: 'none'
        });
    });
    it('drops anchors, unknown schemes, malformed file URIs, and empty hrefs', ()=>{
        expect(routeNativeChatHref('#section')).toEqual({
            kind: 'none'
        });
        expect(routeNativeChatHref(undefined)).toEqual({
            kind: 'none'
        });
        expect(routeNativeChatHref('editor://file/x.ts')).toEqual({
            kind: 'none'
        });
        expect(routeNativeChatHref('javascript:alert(1)')).toEqual({
            kind: 'none'
        });
        expect(routeNativeChatHref('file:///tmp/%E0%A4%A.txt')).toEqual({
            kind: 'none'
        });
    });
});
