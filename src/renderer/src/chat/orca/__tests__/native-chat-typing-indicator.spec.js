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
import { NATIVE_CHAT_STREAMING_ID } from "../shared/native-chat-streaming.js";
import { projectStructuredItemsToNativeChat } from "../shared/structured-agent-session-projection.js";
import { shouldShowNativeChatTypingIndicator } from "../native-chat-typing-indicator.js";
function message(id, role, text = id) {
    return {
        id,
        role,
        blocks: [
            {
                type: 'text',
                text
            }
        ],
        timestamp: null,
        source: 'transcript'
    };
}
describe('shouldShowNativeChatTypingIndicator', ()=>{
    it('stays hidden when the session is idle', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('u1', 'user')
            ],
            isWorking: false
        })).toBe(false);
    });
    it('shows once a send lands and no assistant row exists yet', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('a0', 'assistant'),
                message('u1', 'user')
            ],
            isWorking: true
        })).toBe(true);
    });
    it('hides as soon as the structured reply row arrives, before working clears', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('u1', 'user'),
                message('orca-item', 'assistant')
            ],
            isWorking: true
        })).toBe(false);
    });
    it('hides behind the PTY streaming bubble', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('u1', 'user'),
                message(NATIVE_CHAT_STREAMING_ID, 'assistant')
            ],
            isWorking: true
        })).toBe(false);
    });
    it('does not flicker back on when a system row interleaves mid-turn', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('u1', 'user'),
                message('a1', 'assistant'),
                message('s1', 'system', 'Ran /status')
            ],
            isWorking: true
        })).toBe(false);
    });
    it('shows again for the next send even though an earlier turn replied', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('u1', 'user'),
                message('a1', 'assistant'),
                message('u2', 'user')
            ],
            isWorking: true
        })).toBe(true);
    });
    it('does not let an unresolved tool from an earlier turn hide the next send indicator', ()=>{
        const earlierRunningTool = {
            id: 'tool-old',
            role: 'assistant',
            blocks: [
                {
                    type: 'tool-call',
                    name: 'shell',
                    input: {
                        command: 'sleep 1'
                    },
                    state: 'running'
                }
            ],
            timestamp: null,
            source: 'transcript'
        };
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                earlierRunningTool,
                message('a1', 'assistant'),
                message('u2', 'user')
            ],
            isWorking: true
        })).toBe(true);
    });
    it('shows after a slash-command marker even though an earlier turn replied', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [
                message('a1', 'assistant'),
                message('command:compact', 'system', 'Ran /compact')
            ],
            isWorking: true
        })).toBe(true);
    });
    it('shows on a session whose transcript is still empty', ()=>{
        expect(shouldShowNativeChatTypingIndicator({
            messages: [],
            isWorking: true
        })).toBe(true);
    });
});
describe('with rows projected from the structured journal', ()=>{
    function toolCallItem(sequence) {
        return {
            itemId: `codex:thread-1:turn-1:${sequence}`,
            revision: 1,
            sequence,
            observedAt: 1_800_000_000_000,
            body: {
                kind: 'tool-call',
                name: 'shell',
                state: 'running',
                input: {
                    command: 'sed -n 1,240p README.md'
                }
            }
        };
    }
    function assistantTextItem(sequence) {
        return {
            itemId: `codex:thread-1:turn-1:${sequence}`,
            revision: 1,
            sequence,
            observedAt: 1_800_000_000_000,
            body: {
                kind: 'message',
                role: 'assistant',
                blocks: [
                    {
                        type: 'text',
                        text: "I'm checking PR 14696's metadata."
                    }
                ]
            }
        };
    }
    it('stays visible beside the structured live tool row while a command runs', ()=>{
        const messages = projectStructuredItemsToNativeChat([
            assistantTextItem(1),
            toolCallItem(2)
        ]);
        expect(messages.at(-1)?.role).toBe('assistant');
        expect(shouldShowNativeChatTypingIndicator({
            messages,
            isWorking: true
        })).toBe(true);
    });
    it('hides once prose is the newest row', ()=>{
        const messages = projectStructuredItemsToNativeChat([
            toolCallItem(1),
            assistantTextItem(2)
        ]);
        expect(shouldShowNativeChatTypingIndicator({
            messages,
            isWorking: true
        })).toBe(false);
    });
    it('stays hidden when the turn is not working, command row or not', ()=>{
        const messages = projectStructuredItemsToNativeChat([
            toolCallItem(1)
        ]);
        expect(shouldShowNativeChatTypingIndicator({
            messages,
            isWorking: false
        })).toBe(false);
    });
});
