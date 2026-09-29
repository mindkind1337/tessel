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
import { nativeChatCardDismissKey } from "../native-chat-dismiss-key.js";
describe('nativeChatCardDismissKey', ()=>{
    it('returns null for no card', ()=>{
        expect(nativeChatCardDismissKey(null)).toBeNull();
    });
    it('keys a question by its full canonical content', ()=>{
        const key = nativeChatCardDismissKey({
            kind: 'question',
            prompt: {
                questions: [
                    {
                        question: 'Pick a color',
                        multiSelect: false,
                        options: [
                            {
                                label: 'Red'
                            }
                        ]
                    },
                    {
                        question: 'Pick a size',
                        multiSelect: false,
                        options: [
                            {
                                label: 'L'
                            }
                        ]
                    }
                ]
            }
        });
        expect(key).toContain('Pick a color');
        expect(key).toContain('Pick a size');
    });
    it('gives identical questions the same key (so a lingering re-emit stays hidden)', ()=>{
        const make = ()=>nativeChatCardDismissKey({
                kind: 'question',
                prompt: {
                    questions: [
                        {
                            question: 'Continue?',
                            multiSelect: false,
                            options: []
                        }
                    ]
                }
            });
        expect(make()).toBe(make());
    });
    it('distinguishes prompts whose later questions or options changed', ()=>{
        const card = (second, option)=>nativeChatCardDismissKey({
                kind: 'question',
                prompt: {
                    questions: [
                        {
                            question: 'Same first',
                            multiSelect: false,
                            options: []
                        },
                        {
                            question: second,
                            multiSelect: false,
                            options: [
                                {
                                    label: option
                                }
                            ]
                        }
                    ]
                }
            });
        expect(card('Old second', 'A')).not.toBe(card('New second', 'A'));
        expect(card('Old second', 'A')).not.toBe(card('Old second', 'B'));
    });
    it('keys an approval by its title and detail', ()=>{
        const key = nativeChatCardDismissKey({
            kind: 'approval',
            approval: {
                title: 'Allow Bash?',
                detail: 'rm -rf build',
                options: [
                    {
                        label: 'Allow',
                        send: '1'
                    }
                ]
            }
        });
        expect(key).toBe('approval:Allow Bash?:rm -rf build');
    });
    it('distinguishes different approvals', ()=>{
        const a = nativeChatCardDismissKey({
            kind: 'approval',
            approval: {
                title: 'Allow Bash?',
                options: []
            }
        });
        const b = nativeChatCardDismissKey({
            kind: 'approval',
            approval: {
                title: 'Allow Write?',
                options: []
            }
        });
        expect(a).not.toBe(b);
    });
});
