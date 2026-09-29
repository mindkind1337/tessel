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
import { resolveInitialNativeChatSessionOptions } from "../native-chat-launch-session-options.js";
const settings = {
    experimentalNativeChat: true,
    openAgentTabsInChatByDefault: true,
    nativeChatSessionOptions: {
        codex: {
            model: 'gpt-5.2-codex',
            valuesByModel: {
                'gpt-5.2-codex': {
                    effort: 'medium'
                }
            }
        }
    }
};
describe('resolveInitialNativeChatSessionOptions', ()=>{
    it('omits native-chat preferences from terminal-default launches', ()=>{
        expect(resolveInitialNativeChatSessionOptions({
            ...settings,
            openAgentTabsInChatByDefault: false
        }, {
            agent: 'codex'
        })).toBeUndefined();
    });
    it('applies native-chat preferences when the launch resolves to chat', ()=>{
        expect(resolveInitialNativeChatSessionOptions(settings, {
            agent: 'codex'
        })).toEqual({
            model: 'gpt-5.2-codex',
            effort: 'medium'
        });
    });
    it('omits preferences when a draft forces the initial view back to terminal', ()=>{
        expect(resolveInitialNativeChatSessionOptions(settings, {
            agent: 'codex',
            promptDelivery: 'draft',
            launchDraftText: 'one\u2028two'
        })).toBeUndefined();
    });
    it('omits preferences when a remote transcript forces the initial view to terminal', ()=>{
        const grokSettings = {
            ...settings,
            nativeChatSessionOptions: {
                grok: {
                    model: 'grok-4.5'
                }
            }
        };
        expect(resolveInitialNativeChatSessionOptions(grokSettings, {
            agent: 'grok',
            nativeChatTranscriptIsLocalReadable: false
        })).toBeUndefined();
    });
});
