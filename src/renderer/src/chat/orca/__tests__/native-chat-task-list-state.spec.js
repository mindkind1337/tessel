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
import { nativeChatTaskListState } from "../native-chat-task-list-state.js";
function message(id, blocks) {
    return {
        id,
        role: 'assistant',
        timestamp: 1,
        source: 'transcript',
        blocks
    };
}
function call(content, status = 'pending') {
    return {
        type: 'tool-call',
        name: 'TodoWrite',
        input: {
            todos: [
                {
                    content,
                    status
                }
            ]
        }
    };
}
describe('nativeChatTaskListState', ()=>{
    it('projects one latest snapshot, preserves prose and leaves source messages unchanged', ()=>{
        const first = message('first', [
            call('Read')
        ]);
        const last = message('last', [
            {
                type: 'text',
                text: 'Here is the result'
            },
            call('Read', 'completed'),
            {
                type: 'tool-result',
                output: 'Updated todos'
            }
        ]);
        const result = nativeChatTaskListState([
            first,
            last
        ]);
        expect(result.list?.tasks).toEqual([
            {
                content: 'Read',
                status: 'completed'
            }
        ]);
        expect(result.messages[0]).toBe(first);
        expect(result.messages[1]).toBe(last);
        expect(first.blocks).toHaveLength(1);
        expect(last.blocks).toHaveLength(3);
        expect(nativeChatTaskListState([
            first,
            last
        ]).messages[1]).toBe(result.messages[1]);
    });
    it('preserves latest state across user follow-ups and clears it on an explicit empty list', ()=>{
        const first = message('first', [
            call('Read')
        ]);
        const user = {
            ...message('user', [
                {
                    type: 'text',
                    text: 'Continue'
                }
            ]),
            role: 'user'
        };
        const empty = message('empty', [
            {
                type: 'tool-call',
                name: 'TodoWrite',
                input: {
                    todos: []
                }
            }
        ]);
        expect(nativeChatTaskListState([
            first,
            user
        ]).list?.tasks).toHaveLength(1);
        expect(nativeChatTaskListState([
            first,
            user,
            empty
        ]).list?.tasks).toEqual([]);
        expect(nativeChatTaskListState([]).list).toBeNull();
    });
    it('does not replace valid state with malformed or failed calls, and retains their diagnostics', ()=>{
        const first = message('first', [
            call('Read')
        ]);
        const malformed = message('malformed', [
            {
                type: 'tool-call',
                name: 'TodoWrite',
                input: '{'
            },
            {
                type: 'tool-result',
                output: 'Invalid arguments',
                isError: true
            }
        ]);
        const failed = message('failed', [
            call('Wrong', 'completed'),
            {
                type: 'tool-result',
                output: 'Update rejected',
                isError: true
            }
        ]);
        const failedCall = message('failed-call', [
            {
                type: 'tool-call',
                name: 'TodoWrite',
                state: 'failed',
                input: {
                    todos: []
                }
            }
        ]);
        const result = nativeChatTaskListState([
            first,
            malformed,
            failed,
            failedCall
        ]);
        expect(result.list?.tasks[0].content).toBe('Read');
        expect(result.messages.slice(1)).toEqual([
            malformed,
            failed,
            failedCall
        ]);
    });
    it('retains task history and unrelated errors while selecting the paired snapshot', ()=>{
        const tasks = call('Read');
        const shell = {
            type: 'tool-call',
            name: 'shell',
            input: {}
        };
        const error = {
            type: 'tool-result',
            output: 'Failed',
            isError: true
        };
        const success = {
            type: 'tool-result',
            output: 'Updated'
        };
        const result = nativeChatTaskListState([
            message('mixed', [
                tasks,
                success,
                shell,
                error
            ])
        ]);
        expect(result.list?.tasks[0].content).toBe('Read');
        expect(result.messages[0].blocks).toEqual([
            tasks,
            success,
            shell,
            error
        ]);
    });
});
