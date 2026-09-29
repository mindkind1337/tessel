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
import { normalizeNativeChatTaskList } from "./shared/native-chat-task-list.js";
const projectedFrames = new WeakMap();
export function projectNativeChatTaskListFrames(messages) {
    return messages.map((message)=>{
        const cached = projectedFrames.get(message);
        if (cached) {
            return cached;
        }
        const block = message.blocks.length === 1 ? message.blocks[0] : undefined;
        const frame = block?.type === 'text' ? block.providerFrame : undefined;
        if (message.role !== 'system' || frame?.provider !== 'codex' || frame.kind !== 'notification:turn/plan/updated' || frame.payload.truncated || !normalizeNativeChatTaskList('update_plan', frame.payload.head)) {
            return message;
        }
        const projected = {
            ...message,
            role: 'assistant',
            blocks: [
                {
                    type: 'tool-call',
                    name: 'update_plan',
                    input: frame.payload.head,
                    state: 'completed'
                }
            ]
        };
        projectedFrames.set(message, projected);
        return projected;
    });
}
