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
import { isToolCallBlock, isToolResultBlock } from "./shared/native-chat-types.js";
import { compareMessages } from "./native-chat-session-assembler.js";
export function orderNativeChatMessages(messages) {
    return [
        ...messages
    ].sort(compareMessages);
}
function collectToolResults(messages) {
    const results = [];
    for (const message of messages){
        for (const block of message.blocks){
            if (isToolResultBlock(block)) {
                results.push(block);
            }
        }
    }
    return results;
}
export function buildNativeChatRenderItems(messages) {
    const ordered = orderNativeChatMessages(messages);
    const resultQueue = collectToolResults(ordered);
    let resultCursor = 0;
    const items = [];
    for (const message of ordered){
        const nonToolBlocks = [];
        const steps = [];
        for (const block of message.blocks){
            if (isToolCallBlock(block)) {
                const result = resultQueue[resultCursor] ?? null;
                if (result) {
                    resultCursor += 1;
                }
                steps.push({
                    call: block,
                    result
                });
            } else if (isToolResultBlock(block)) {
                continue;
            } else {
                nonToolBlocks.push(block);
            }
        }
        if (nonToolBlocks.length > 0) {
            items.push({
                kind: 'message',
                id: message.id,
                message,
                blocks: nonToolBlocks
            });
        }
        for (const [index, step] of steps.entries()){
            items.push({
                kind: 'tool-step',
                id: `${message.id}:tool:${index}`, // i18n-ignore
                role: message.role,
                timestamp: message.timestamp,
                step
            });
        }
    }
    return items;
}
