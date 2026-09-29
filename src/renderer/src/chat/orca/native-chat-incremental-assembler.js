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
import { hasImagePromptMarker, isImageSourceUserTurn } from "./shared/native-chat-image-transcript-markers.js";
import { compareMessages, mergeOne, sortForImageNormalization } from "./native-chat-session-assembler.js";
export function createIncrementalAssembler() {
    return {
        byId: new Map(),
        byTurn: new Map(),
        messages: []
    };
}
export function reset(assembler, base) {
    assembler.byId = new Map();
    assembler.byTurn = new Map();
    for (const message of base){
        mergeOne(assembler.byId, assembler.byTurn, message);
    }
    assembler.messages = [
        ...sortForImageNormalization(Array.from(assembler.byId.values()))
    ];
    return assembler.messages;
}
export function applyAppends(assembler, incoming) {
    if (incoming.length === 0) {
        return assembler.messages;
    }
    const sizeBefore = assembler.byId.size;
    for (const message of incoming){
        mergeOne(assembler.byId, assembler.byTurn, message);
    }
    const grewByBatch = assembler.byId.size === sizeBefore + incoming.length;
    if (grewByBatch && isTailAppend(assembler.messages, incoming)) {
        const tail = [
            ...sortForImageNormalization(incoming)
        ];
        assembler.messages = [
            ...assembler.messages,
            ...tail
        ];
        return assembler.messages;
    }
    assembler.messages = [
        ...sortForImageNormalization(Array.from(assembler.byId.values()))
    ];
    return assembler.messages;
}
function isTailAppend(current, incoming) {
    const last = current.at(-1);
    if (!last) {
        return true;
    }
    if (hasImagePromptMarker(last) && incoming[0]?.source === last.source && incoming[0]?.timestamp === last.timestamp && isImageSourceUserTurn(incoming[0])) {
        return false;
    }
    for (const message of incoming){
        if (message.timestamp === null) {
            return false;
        }
        if (compareMessages(message, last) < 0) {
            return false;
        }
    }
    return true;
}
