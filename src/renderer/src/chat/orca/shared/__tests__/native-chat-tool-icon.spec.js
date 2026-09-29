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
import { isShellActivityToolCall, NATIVE_CHAT_TOOL_ICON_NAMES, nativeChatToolCategory, nativeChatToolIconName, nativeChatToolRunCategory, nativeChatToolRunIconName } from "../native-chat-tool-icon.js";
const ALL_CATEGORIES = [
    'read',
    'search',
    'listFiles',
    'unknown',
    'fileChange',
    'webSearch',
    'mcpToolCall',
    'subAgentActivity',
    'todoList',
    'other'
];
describe('native chat tool icons', ()=>{
    it('names a glyph for every category in the vocabulary', ()=>{
        expect(NATIVE_CHAT_TOOL_ICON_NAMES).toEqual({
            read: 'eye',
            search: 'search',
            listFiles: 'folder',
            unknown: 'square-terminal',
            fileChange: 'pencil',
            webSearch: 'globe',
            mcpToolCall: 'plug',
            subAgentActivity: 'bot',
            todoList: 'list-checks',
            other: 'wrench'
        });
        expect(Object.keys(NATIVE_CHAT_TOOL_ICON_NAMES).sort()).toEqual([
            ...ALL_CATEGORIES
        ].sort());
    });
    it('gives each category a distinct glyph so rows are told apart by icon', ()=>{
        const glyphs = ALL_CATEGORIES.map((category)=>NATIVE_CHAT_TOOL_ICON_NAMES[category]);
        expect(new Set(glyphs).size).toBe(glyphs.length);
    });
    it('maps the row words the Codex lane renders to their category', ()=>{
        expect(nativeChatToolCategory('read')).toBe('read');
        expect(nativeChatToolCategory('search')).toBe('search');
        expect(nativeChatToolCategory('list')).toBe('listFiles');
        expect(nativeChatToolCategory('shell')).toBe('unknown');
        expect(nativeChatToolCategory('apply_patch')).toBe('fileChange');
        expect(nativeChatToolCategory('update_plan')).toBe('todoList');
        expect(nativeChatToolIconName('update_plan')).toBe('list-checks');
        expect(nativeChatToolRunIconName([
            {
                name: 'update_plan'
            }
        ])).toBe('list-checks');
        expect(nativeChatToolCategory('web search')).toBe('webSearch');
    });
    it('maps the tool names the Claude lane renders verbatim', ()=>{
        expect(nativeChatToolIconName('Read')).toBe('eye');
        expect(nativeChatToolIconName('Bash')).toBe('square-terminal');
        expect(nativeChatToolIconName('Grep')).toBe('search');
        expect(nativeChatToolIconName('Glob')).toBe('search');
        expect(nativeChatToolIconName('Task')).toBe('bot');
        expect(nativeChatToolIconName('WebFetch')).toBe('globe');
        expect(nativeChatToolIconName('TodoWrite')).toBe('list-checks');
    });
    it('reads the whole edit family from the shared set, not a parallel list', ()=>{
        for (const name of [
            'Edit',
            'MultiEdit',
            'Write',
            'str_replace',
            'apply_patch'
        ]){
            expect(nativeChatToolCategory(name)).toBe('fileChange');
            expect(nativeChatToolIconName(name)).toBe('pencil');
        }
    });
    it('reads the projected `Diff` row as a file change, which is what it renders', ()=>{
        expect(nativeChatToolCategory('Diff')).toBe('fileChange');
        expect(nativeChatToolIconName('Diff')).toBe('pencil');
    });
    it('reads an MCP tool by its prefix, since the row is named after the tool', ()=>{
        expect(nativeChatToolCategory('mcp__linear__create_issue')).toBe('mcpToolCall');
        expect(nativeChatToolIconName('mcp__playwright__browser_click')).toBe('plug');
        expect(nativeChatToolCategory('run_mcp__thing')).toBeNull();
    });
    it('resolves the glyph for each classified row word', ()=>{
        expect(nativeChatToolIconName('read')).toBe('eye');
        expect(nativeChatToolIconName('search')).toBe('search');
        expect(nativeChatToolIconName('list')).toBe('folder');
        expect(nativeChatToolIconName('shell')).toBe('square-terminal');
        expect(nativeChatToolIconName('edit')).toBe('pencil');
        expect(nativeChatToolIconName('web search')).toBe('globe');
    });
    it('reads a row word regardless of case or surrounding space', ()=>{
        expect(nativeChatToolIconName('  Read ')).toBe('eye');
        expect(nativeChatToolIconName('WebSearch')).toBe('globe');
    });
    it('falls back to the generic tool glyph, not the terminal, outside the vocabulary', ()=>{
        expect(nativeChatToolCategory('AskUserQuestion')).toBeNull();
        expect(nativeChatToolIconName('AskUserQuestion')).toBe('wrench');
        expect(nativeChatToolIconName('')).toBe('wrench');
    });
    it('keeps the terminal glyph for a row that really ran a command', ()=>{
        for (const name of [
            'shell',
            'bash',
            'run_terminal_cmd',
            'exec',
            'local_shell'
        ]){
            expect(nativeChatToolCategory(name)).toBe('unknown');
            expect(nativeChatToolIconName(name)).toBe('square-terminal');
        }
    });
    describe('terminal activity for a two-glyph lane', ()=>{
        it('reads a classified Codex row as terminal activity, by the command it kept', ()=>{
            for (const [name, fields] of [
                [
                    'read',
                    {
                        path: 'src/app.ts'
                    }
                ],
                [
                    'search',
                    {
                        query: 'todo',
                        directory: 'src'
                    }
                ],
                [
                    'list',
                    {
                        directory: 'src'
                    }
                ]
            ]){
                expect(isShellActivityToolCall({
                    name,
                    input: {
                        command: 'rg todo src',
                        cwd: '/repo',
                        ...fields
                    }
                })).toBe(true);
            }
        });
        it('reads an unclassified shell row as terminal activity, by its name', ()=>{
            for (const name of [
                'shell',
                'bash',
                'Bash',
                'run_terminal_cmd'
            ]){
                expect(isShellActivityToolCall({
                    name,
                    input: null
                })).toBe(true);
            }
        });
        it('reads a rollout-transcript shell call as terminal activity', ()=>{
            expect(isShellActivityToolCall({
                name: 'exec',
                input: '{"command":["bash","-lc","ls"]}'
            })).toBe(true);
            expect(isShellActivityToolCall({
                name: 'local_shell',
                input: {
                    command: [
                        'bash',
                        '-lc',
                        'ls'
                    ]
                }
            })).toBe(true);
        });
        it('leaves a Claude filesystem tool a generic tool, since no command ran', ()=>{
            expect(isShellActivityToolCall({
                name: 'Read',
                input: {
                    file_path: '/repo/src/app.ts'
                }
            })).toBe(false);
            expect(isShellActivityToolCall({
                name: 'Grep',
                input: {
                    pattern: 'todo',
                    path: 'src'
                }
            })).toBe(false);
            expect(isShellActivityToolCall({
                name: 'Glob',
                input: {
                    pattern: '**/*.ts'
                }
            })).toBe(false);
        });
        it('leaves an unmodelled tool a generic tool', ()=>{
            expect(isShellActivityToolCall({
                name: 'AskUserQuestion',
                input: {
                    question: 'which?'
                }
            })).toBe(false);
            for (const name of [
                'Edit',
                'Diff',
                'Task',
                'WebFetch',
                'TodoWrite',
                ''
            ]){
                expect(isShellActivityToolCall({
                    name,
                    input: {
                        file_path: 'a.ts'
                    }
                })).toBe(false);
            }
        });
        it('answers false for an input that carries no command, whatever its shape', ()=>{
            for (const input of [
                null,
                undefined,
                'ls -la',
                42,
                [
                    'bash',
                    '-lc',
                    'ls'
                ],
                {},
                {
                    cwd: '/r'
                }
            ]){
                expect(isShellActivityToolCall({
                    name: 'read',
                    input
                })).toBe(false);
            }
            expect(isShellActivityToolCall({
                name: 'read',
                input: {
                    command: '   '
                }
            })).toBe(false);
            expect(isShellActivityToolCall({
                name: 'read',
                input: {
                    command: null
                }
            })).toBe(false);
        });
    });
    describe('the glyph over a whole run', ()=>{
        it('keeps the category when every call in the run is of it', ()=>{
            const run = [
                {
                    name: 'Read'
                },
                {
                    name: 'read'
                },
                {
                    name: '  Read  '
                }
            ];
            expect(nativeChatToolRunCategory(run)).toBe('read');
            expect(nativeChatToolRunIconName(run)).toBe('eye');
        });
        it('reads a run of differently-named shell calls as one shell run', ()=>{
            const run = [
                {
                    name: 'shell'
                },
                {
                    name: 'Bash'
                },
                {
                    name: 'local_shell'
                }
            ];
            expect(nativeChatToolRunCategory(run)).toBe('unknown');
            expect(nativeChatToolRunIconName(run)).toBe('square-terminal');
        });
        it('falls back to the generic tool glyph when the run spans categories', ()=>{
            const run = [
                {
                    name: 'shell'
                },
                {
                    name: 'Read'
                }
            ];
            expect(nativeChatToolRunCategory(run)).toBeNull();
            expect(nativeChatToolRunIconName(run)).toBe('wrench');
            expect(nativeChatToolRunIconName([
                {
                    name: 'Read'
                },
                {
                    name: 'shell'
                }
            ])).toBe('wrench');
        });
        it('takes a single call at its own category', ()=>{
            expect(nativeChatToolRunCategory([
                {
                    name: 'Grep'
                }
            ])).toBe('search');
            expect(nativeChatToolRunIconName([
                {
                    name: 'Grep'
                }
            ])).toBe('search');
            expect(nativeChatToolRunIconName([
                {
                    name: 'apply_patch'
                }
            ])).toBe('pencil');
        });
        it('reads a run of unmodelled tools as the generic category, not as spanning', ()=>{
            const run = [
                {
                    name: 'AskUserQuestion'
                },
                {
                    name: 'SomeOtherTool'
                }
            ];
            expect(nativeChatToolRunCategory(run)).toBe('other');
            expect(nativeChatToolRunIconName(run)).toBe('wrench');
        });
        it('has no glyph to give a run with no tool calls', ()=>{
            expect(nativeChatToolRunCategory([])).toBeNull();
            expect(nativeChatToolRunIconName([])).toBeNull();
        });
    });
    it('does not answer a prototype key with a glyph', ()=>{
        expect(nativeChatToolCategory('__proto__')).toBeNull();
        expect(nativeChatToolCategory('constructor')).toBeNull();
        expect(nativeChatToolIconName('__proto__')).toBe('wrench');
    });
});
describe('qualified tool identity icons', ()=>{
    it.each([
        'mcp__linear__list_issues'
    ])('uses the MCP glyph for %s', (name)=>expect(nativeChatToolIconName(name)).toBe('plug'));
    it.each([
        'setup.py',
        'src/read',
        'src/tool.ts',
        '/usr/bin/tool',
        'tools/read',
        'browser.open',
        'package.lock',
        'linear/list_issues',
        'linear.list_issues'
    ])('does not claim MCP for %s', (name)=>expect(nativeChatToolCategory(name)).toBeNull());
    it('uses confirmed MCP metadata for row and run icons', ()=>{
        const call = {
            name: 'linear/list_issues',
            mcpIdentity: {
                server: 'linear',
                tool: 'list_issues'
            }
        };
        expect(nativeChatToolIconName(call.name, call.mcpIdentity)).toBe('plug');
        expect(nativeChatToolRunIconName([
            call
        ])).toBe('plug');
    });
    it('keeps classified command and web identities', ()=>{
        expect(nativeChatToolCategory('read')).toBe('read');
        expect(nativeChatToolCategory('search')).toBe('search');
        expect(nativeChatToolCategory('list')).toBe('listFiles');
        expect(nativeChatToolIconName('web_search')).toBe('globe');
    });
});
