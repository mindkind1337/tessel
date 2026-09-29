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
import { projectNativeChatTranscriptMessages } from "./shared/native-chat-transcript-projection.js";
import { compareMessages } from "./native-chat-session-assembler.js";
function sameMessage(left, right) {
    if (left === right) {
        return true;
    }
    const keys = Object.keys(left);
    return keys.length === Object.keys(right).length && keys.every((key)=>Object.hasOwn(right, key) && (key === 'blocks' || left[key] === right[key])) && left.blocks.length === right.blocks.length && left.blocks.every((block, index)=>block === right.blocks[index]);
}
export function createNativeChatMessageListProjection() {
    let previous = [];
    let byId = new Map();
    return (messages)=>{
        const folded = projectNativeChatTranscriptMessages(messages, compareMessages);
        const next = folded.map((message)=>{
            const prior = byId.get(message.id);
            return prior && sameMessage(prior, message) ? prior : message;
        });
        if (next.length === previous.length && next.every((message, index)=>message === previous[index])) {
            return previous;
        }
        previous = next;
        byId = new Map(next.map((message)=>[
                message.id,
                message
            ]));
        return next;
    };
}
