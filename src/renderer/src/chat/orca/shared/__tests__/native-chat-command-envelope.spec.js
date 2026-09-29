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
import { parseNativeChatCommandEnvelope, surfaceSkillInvocationUserTurns } from "../native-chat-command-envelope.js";
const CATALOG = new Set([
    'clear',
    'model'
]);
function userTurn(text, overrides = {}) {
    return {
        id: 'user-1',
        role: 'user',
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp: 100,
        source: 'transcript',
        ...overrides
    };
}
describe('parseNativeChatCommandEnvelope', ()=>{
    it('parses name-first and message-first envelope orderings', ()=>{
        expect(parseNativeChatCommandEnvelope('<command-name>/model</command-name>\n  <command-message>model</command-message>\n  <command-args></command-args>')).toEqual({
            name: '/model',
            args: ''
        });
        expect(parseNativeChatCommandEnvelope('<command-message>ce-brainstorm</command-message>\n<command-name>/ce-brainstorm</command-name>\n<command-args>improve the picker</command-args>')).toEqual({
            name: '/ce-brainstorm',
            args: 'improve the picker'
        });
    });
    it('ignores ordinary prompts and non-leading envelope tags', ()=>{
        expect(parseNativeChatCommandEnvelope('deploy the app')).toBeNull();
        expect(parseNativeChatCommandEnvelope('see <command-name>/x</command-name>')).toBeNull();
        expect(parseNativeChatCommandEnvelope('<commander>/x</commander>')).toBeNull();
    });
});
describe('surfaceSkillInvocationUserTurns', ()=>{
    it('renders a skill-invocation envelope as the literal user token', ()=>{
        const messages = [
            userTurn('<command-message>ce-brainstorm</command-message>\n<command-name>/ce-brainstorm</command-name>\n<command-args>improve the picker</command-args>')
        ];
        const out = surfaceSkillInvocationUserTurns(messages, CATALOG);
        expect(out[0].blocks).toEqual([
            {
                type: 'text',
                text: '/ce-brainstorm improve the picker'
            }
        ]);
        expect(out[0].id).toBe('user-1');
    });
    it('shortens plugin-qualified names back to the token the user sent', ()=>{
        const messages = [
            userTurn('<command-message>compound-engineering:ce-brainstorm</command-message>\n<command-name>/compound-engineering:ce-brainstorm</command-name>\n<command-args>hi</command-args>')
        ];
        const out = surfaceSkillInvocationUserTurns(messages, CATALOG);
        expect(out[0].blocks).toEqual([
            {
                type: 'text',
                text: '/ce-brainstorm hi'
            }
        ]);
    });
    it('never hides a plugin skill whose short name shadows a catalog command', ()=>{
        const messages = [
            userTurn('<command-name>/some-plugin:clear</command-name>\n<command-args></command-args>')
        ];
        const out = surfaceSkillInvocationUserTurns(messages, CATALOG);
        expect(out[0].blocks).toEqual([
            {
                type: 'text',
                text: '/clear'
            }
        ]);
    });
    it('leaves catalog command envelopes for the noise filter and Ran marker', ()=>{
        const messages = [
            userTurn('<command-name>/model</command-name>\n<command-args></command-args>')
        ];
        expect(surfaceSkillInvocationUserTurns(messages, CATALOG)).toBe(messages);
    });
    it('does not touch assistant turns, plain prompts, or non-text blocks', ()=>{
        const messages = [
            userTurn('hello there'),
            userTurn('<command-name>/skill</command-name>', {
                id: 'user-2',
                role: 'assistant'
            }),
            userTurn('<command-name>/skill</command-name>', {
                id: 'user-3',
                blocks: [
                    {
                        type: 'text',
                        text: '<command-name>/skill</command-name>'
                    },
                    {
                        type: 'image-ref',
                        path: '/tmp/a.png'
                    }
                ]
            })
        ];
        expect(surfaceSkillInvocationUserTurns(messages, CATALOG)).toBe(messages);
    });
});
