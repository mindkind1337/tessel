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
import { NATIVE_CHAT_STREAMING_ID } from "./shared/native-chat-streaming.js";
import { isCommandMarkerId } from "./native-chat-command-marker.js";
function isToolActivityOnlyRow(message) {
    const blocks = message.blocks;
    if (!blocks || blocks.length === 0) {
        return false;
    }
    return blocks.every((block)=>block.type === 'tool-call' || block.type === 'tool-result');
}
export function shouldShowNativeChatTypingIndicator(args) {
    if (!args.isWorking) {
        return false;
    }
    const { messages } = args;
    for(let index = messages.length - 1; index >= 0; index -= 1){
        const message = messages[index];
        if (!message || message.role === 'user' || isCommandMarkerId(message.id)) {
            return true;
        }
        if (isToolActivityOnlyRow(message)) {
            return true;
        }
        if (message.role === 'assistant' || message.id === NATIVE_CHAT_STREAMING_ID) {
            return false;
        }
    }
    return true;
}
