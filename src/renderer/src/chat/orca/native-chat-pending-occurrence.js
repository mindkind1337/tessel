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
import { normalizeNativeChatUserText, normalizedNativeChatUserMessageText } from "./shared/native-chat-image-transcript-markers.js";
import { isImageRefBlock } from "./shared/native-chat-types.js";
export function normalizeNativeChatPendingText(text) {
    return normalizeNativeChatUserText(text);
}
export function nativeChatPendingContentKey(pending) {
    const text = normalizeNativeChatPendingText(pending.text);
    if (text) {
        return `text:${text}`; // i18n-ignore
    }
    const imagePaths = pending.imagePaths?.filter(Boolean) ?? [];
    return imagePaths.length > 0 ? `images:${JSON.stringify(imagePaths)}` : 'empty'; // i18n-ignore
}
function nativeChatUserMessageContentKey(message) {
    if (message.role !== 'user') {
        return null;
    }
    const text = normalizedNativeChatUserMessageText(message) ?? '';
    if (text) {
        return `text:${text}`; // i18n-ignore
    }
    const imagePaths = message.blocks.filter(isImageRefBlock).map((block)=>block.path).filter((path)=>Boolean(path));
    const key = nativeChatPendingContentKey({
        text: '',
        imagePaths
    });
    return key === 'empty' ? null : key;
}
export function matchingNativeChatUserContentCounts(messages) {
    const counts = new Map();
    for (const message of messages){
        const key = nativeChatUserMessageContentKey(message);
        if (key) {
            counts.set(key, (counts.get(key) ?? 0) + 1);
        }
    }
    return counts;
}
export function advancedNativeChatUserContentCounts(messages) {
    const advanced = new Map();
    const waiting = new Map();
    for (const message of messages){
        if (message.role === 'user') {
            const key = nativeChatUserMessageContentKey(message);
            if (key) {
                waiting.set(key, (waiting.get(key) ?? 0) + 1);
            }
            continue;
        }
        for (const [key, count] of waiting){
            advanced.set(key, (advanced.get(key) ?? 0) + count);
        }
        waiting.clear();
    }
    return advanced;
}
export function advancedNativeChatUserRows(messages) {
    const advanced = [];
    const waiting = [];
    for (const message of messages){
        if (message.role === 'user') {
            const text = normalizedNativeChatUserMessageText(message);
            if (text) {
                waiting.push({
                    id: message.id,
                    text
                });
            }
            continue;
        }
        advanced.push(...waiting);
        waiting.length = 0;
    }
    return advanced;
}
export function matchingNativeChatUserRows(messages) {
    const rows = [];
    for (const message of messages){
        const text = normalizedNativeChatUserMessageText(message);
        if (text) {
            rows.push({
                id: message.id,
                text
            });
        }
    }
    return rows;
}
export function countLeadingPendingTextsGluedToUserText(pendingTexts, userText) {
    if (pendingTexts.length === 0 || userText.length === 0) {
        return 0;
    }
    let cursor = 0;
    for(let index = 0; index < pendingTexts.length; index += 1){
        const piece = pendingTexts[index];
        if (!piece) {
            return 0;
        }
        if (userText.startsWith(piece, cursor)) {
            cursor += piece.length;
        } else if (index > 0 && userText.startsWith(` ${piece}`, cursor)) {
            cursor += piece.length + 1;
        } else {
            return 0;
        }
        if (cursor === userText.length) {
            return index + 1;
        }
    }
    return 0;
}
export function selectPendingIndicesRepresentedByUserRows(pending, rows) {
    const represented = new Set();
    if (pending.length < 2 || rows.length === 0) {
        return represented;
    }
    const remaining = pending.map((entry, index)=>({
            index,
            text: normalizeNativeChatPendingText(entry.text)
        }));
    for (const row of rows){
        const open = [];
        for (const entry of remaining){
            if (represented.has(entry.index) || entry.text.length === 0) {
                continue;
            }
            if (!row.representablePendingIndices.has(entry.index)) {
                break;
            }
            open.push(entry);
        }
        const gluedCount = countLeadingPendingTextsGluedToUserText(open.map((entry)=>entry.text), row.text);
        if (gluedCount < 2) {
            continue;
        }
        for(let i = 0; i < gluedCount; i += 1){
            const entry = open[i];
            if (!entry) {
                continue;
            }
            represented.add(entry.index);
            const at = remaining.findIndex((candidate)=>candidate.index === entry.index);
            if (at !== -1) {
                remaining.splice(at, 1);
            }
        }
    }
    return represented;
}
export function nativeChatPendingMatchKey(pending) {
    return `${String(pending.afterMessageId)}\0${nativeChatPendingContentKey(pending)}`;
}
export function assignNativeChatPendingOccurrence(existing, entry) {
    const key = nativeChatPendingMatchKey(entry);
    const matching = existing.filter((candidate)=>nativeChatPendingMatchKey(candidate) === key);
    if (matching.length === 0) {
        return entry;
    }
    const previousOccurrence = Math.max(...matching.map((candidate, index)=>candidate.matchingOccurrence ?? index + 1));
    const first = matching[0];
    return {
        ...entry,
        matchingOccurrence: previousOccurrence + 1,
        matchingAfterTimestamp: first?.matchingAfterTimestamp ?? first?.afterMessageTimestamp ?? first?.sentAt
    };
}
export function nativeChatPendingMatchingAfter(pending) {
    return pending.matchingAfterTimestamp ?? pending.afterMessageTimestamp ?? pending.sentAt;
}
export function nativeChatPendingOccurrence(pending, alreadyConsumed) {
    return pending.matchingOccurrence ?? alreadyConsumed + 1;
}
