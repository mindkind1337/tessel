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
import { NATIVE_CHAT_SOURCE_PRIORITY } from "./native-chat-types.js";
export function mergeNativeChatMessagesWith(existing, incoming, priority) {
    if (incoming.length === 0) {
        return existing;
    }
    const merged = [
        ...existing
    ];
    const indexById = new Map();
    merged.forEach((message, index)=>indexById.set(message.id, index));
    applyIncoming(merged, indexById, incoming, priority);
    return merged;
}
export function mergeNativeChatMessages(existing, incoming) {
    return mergeNativeChatMessagesWith(existing, incoming, NATIVE_CHAT_SOURCE_PRIORITY);
}
export function boundNativeChatWindow(messages, limit) {
    if (limit <= 0 || messages.length <= limit) {
        return messages;
    }
    return messages.slice(messages.length - limit);
}
export function createNativeChatMerger(priority = NATIVE_CHAT_SOURCE_PRIORITY) {
    return {
        list: [],
        indexById: new Map(),
        priority
    };
}
export function replaceList(merger, list) {
    merger.list = [
        ...list
    ];
    merger.indexById.clear();
    merger.list.forEach((message, index)=>merger.indexById.set(message.id, index));
}
export function applyAppend(merger, incoming, limit) {
    if (incoming.length === 0) {
        return merger.list;
    }
    const next = [
        ...merger.list
    ];
    applyIncoming(next, merger.indexById, incoming, merger.priority);
    const bounded = limit === undefined ? next : boundNativeChatWindow(next, limit);
    if (bounded !== next) {
        replaceList(merger, bounded);
        return merger.list;
    }
    merger.list = next;
    return next;
}
function applyIncoming(list, indexById, incoming, priority) {
    for (const message of incoming){
        const at = indexById.get(message.id);
        if (at === undefined) {
            indexById.set(message.id, list.length);
            list.push(message);
            continue;
        }
        const current = list[at];
        if (priority[message.source] >= priority[current.source]) {
            list[at] = message;
        }
    }
}
