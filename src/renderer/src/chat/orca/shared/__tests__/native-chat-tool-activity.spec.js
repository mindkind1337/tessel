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
import { describeActiveToolCall, formatActiveToolLabel, formatToolCallCount, isCommandToolName, selectActiveToolCall } from "../native-chat-tool-activity.js";
function call(name, input, state) {
    return {
        type: 'tool-call',
        name,
        input,
        ...state ? {
            state
        } : {}
    };
}
describe('isCommandToolName', ()=>{
    it('matches the shell-running tools regardless of case or padding', ()=>{
        expect(isCommandToolName('bash')).toBe(true);
        expect(isCommandToolName('  Bash ')).toBe(true);
        expect(isCommandToolName('run_terminal_cmd')).toBe(true);
    });
    it('does not match a named tool', ()=>{
        expect(isCommandToolName('Read')).toBe(false);
        expect(isCommandToolName('')).toBe(false);
    });
});
describe('describeActiveToolCall / formatActiveToolLabel', ()=>{
    it('drops the tool name for a shell command with a preview', ()=>{
        const descriptor = describeActiveToolCall(call('Bash', {
            command: 'npm test'
        }));
        expect(descriptor.key).toBe('runningPreview');
        expect(descriptor.isCommand).toBe(true);
        expect(formatActiveToolLabel(descriptor)).toBe('Running npm test');
    });
    it('falls back to a generic command label when there is no preview', ()=>{
        const descriptor = describeActiveToolCall(call('bash', null));
        expect(descriptor.key).toBe('runningCommand');
        expect(formatActiveToolLabel(descriptor)).toBe('Running command');
    });
    it('keeps the tool name for a non-command tool', ()=>{
        const descriptor = describeActiveToolCall(call('Read', {
            file_path: 'a/b.ts'
        }));
        expect(descriptor.key).toBe('runningNamedPreview');
        expect(descriptor.isCommand).toBe(false);
        expect(formatActiveToolLabel(descriptor)).toBe('Running Read a/b.ts');
    });
    it('names a previewless tool on its own', ()=>{
        const descriptor = describeActiveToolCall(call('Think', null));
        expect(descriptor.key).toBe('runningNamed');
        expect(formatActiveToolLabel(descriptor)).toBe('Running Think');
    });
});
describe('selectActiveToolCall', ()=>{
    it('returns nothing once the turn is known to have ended', ()=>{
        const blocks = [
            call('Bash', {
                command: 'x'
            }, 'running')
        ];
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: false
        })).toBeNull();
    });
    it('picks the latest explicitly running call', ()=>{
        const blocks = [
            call('Read', {
                file_path: 'a'
            }, 'completed'),
            call('Bash', {
                command: 'x'
            }, 'running'),
            call('Grep', {
                pattern: 'y'
            }, 'running')
        ];
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: true
        })?.name).toBe('Grep');
    });
    it('ignores settled calls even while the turn works', ()=>{
        const blocks = [
            call('Read', {
                file_path: 'a'
            }, 'completed')
        ];
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: true
        })).toBeNull();
    });
    it('treats a lifecycle-less call as running only while the turn works', ()=>{
        const blocks = [
            call('Read', {
                file_path: 'a'
            })
        ];
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: true
        })?.name).toBe('Read');
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: undefined
        })).toBeNull();
    });
    it('still surfaces an explicitly running call when the turn state is unknown', ()=>{
        const blocks = [
            call('Bash', {
                command: 'x'
            }, 'running')
        ];
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: undefined
        })?.name).toBe('Bash');
    });
    it('skips non-tool-call blocks', ()=>{
        const blocks = [
            {
                type: 'text',
                text: 'hello'
            },
            call('Bash', {
                command: 'x'
            }, 'running')
        ];
        expect(selectActiveToolCall(blocks, {
            activeTurnIsWorking: true
        })?.name).toBe('Bash');
    });
});
describe('formatToolCallCount', ()=>{
    it('singularizes one call', ()=>{
        expect(formatToolCallCount(1)).toBe('1 tool call');
        expect(formatToolCallCount(4)).toBe('4 tool calls');
        expect(formatToolCallCount(0)).toBe('0 tool calls');
    });
});
