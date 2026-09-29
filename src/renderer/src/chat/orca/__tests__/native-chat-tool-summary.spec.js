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
import { briefToolArg, countToolCalls, summarizeToolInput, summarizeToolRun } from "../native-chat-tool-summary.js";
describe('summarizeToolInput', ()=>{
    it('passes short strings through and collapses whitespace', ()=>{
        expect(summarizeToolInput('  hello   world ')).toBe('hello world');
    });
    it('serializes objects to compact JSON', ()=>{
        expect(summarizeToolInput({
            a: 1
        })).toBe('{"a":1}');
    });
    it('truncates long previews with an ellipsis', ()=>{
        const long = 'x'.repeat(200);
        const out = summarizeToolInput(long);
        expect(out.endsWith('…')).toBe(true);
        expect(out.length).toBe(80);
    });
    it('returns empty for null/undefined', ()=>{
        expect(summarizeToolInput(null)).toBe('');
        expect(summarizeToolInput(undefined)).toBe('');
    });
});
describe('briefToolArg', ()=>{
    it('uses the file basename when present', ()=>{
        expect(briefToolArg({
            file_path: '/a/b/app.tsx'
        })).toBe('app.tsx');
    });
    it('uses the basename for Windows-style backslash paths', ()=>{
        expect(briefToolArg({
            file_path: 'C:\\Users\\me\\project\\app.tsx'
        })).toBe('app.tsx');
    });
    it('uses the basename for Windows-style paths with a trailing backslash', ()=>{
        expect(briefToolArg({
            path: 'C:\\Users\\me\\project\\'
        })).toBe('project');
    });
    it('falls back to a clipped command', ()=>{
        expect(briefToolArg({
            command: 'git status --short'
        })).toBe('git status --short');
    });
});
describe('summarizeToolRun', ()=>{
    it('joins tool-call names with their brief arg', ()=>{
        const blocks = [
            {
                type: 'tool-call',
                name: 'Bash',
                input: {
                    command: 'ls'
                }
            },
            {
                type: 'tool-result',
                output: 'x'
            },
            {
                type: 'tool-call',
                name: 'Edit',
                input: {
                    file_path: '/x/app.tsx'
                }
            }
        ];
        expect(summarizeToolRun(blocks)).toBe('Bash ls  ·  Edit app.tsx');
    });
    it('skips nameless tool calls so the join has no orphan separators', ()=>{
        const blocks = [
            {
                type: 'tool-call',
                name: 'Bash',
                input: {
                    command: 'ls'
                }
            },
            {
                type: 'tool-call',
                name: '   ',
                input: {
                    command: 'x'
                }
            },
            {
                type: 'tool-call',
                name: 'Edit',
                input: {
                    file_path: '/x/app.tsx'
                }
            }
        ];
        expect(summarizeToolRun(blocks)).toBe('Bash ls  ·  Edit app.tsx');
    });
});
describe('countToolCalls', ()=>{
    it('counts only tool-call blocks', ()=>{
        const blocks = [
            {
                type: 'tool-call',
                name: 'Bash',
                input: {}
            },
            {
                type: 'tool-result',
                output: 'x'
            },
            {
                type: 'tool-call',
                name: 'Read',
                input: {}
            }
        ];
        expect(countToolCalls(blocks)).toBe(2);
    });
});
