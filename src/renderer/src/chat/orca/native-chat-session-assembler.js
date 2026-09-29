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
import { isTextBlock, NATIVE_CHAT_SOURCE_PRIORITY } from "./shared/native-chat-types.js";
import { NATIVE_CHAT_STREAMING_ID } from "./shared/native-chat-streaming.js";
import { compareNativeChatMessagesByTime } from "./shared/native-chat-transcript-projection.js";
import { hasImagePromptMarker, isImageSourceUserTurn, normalizeImageTranscriptMessages } from "./shared/native-chat-image-transcript-markers.js";
import { isLaunchPromptMessageId, isPendingMessageId } from "./native-chat-pending.js";
function turnKey(message) {
    if (message.turnId) {
        return `turn:${message.turnId}`; // i18n-ignore
    }
    const text = message.blocks.filter(isTextBlock).map((block)=>block.text).join(' ').toLowerCase().replace(/\s+/g, ' ').trim();
    return `${message.role}:${text}:${nonTextBlockDigest(message)}`;
}
function nonTextBlockDigest(message) {
    const parts = [];
    for (const block of message.blocks){
        if (block.type === 'tool-call') {
            parts.push(`call:${block.name}:${stableStringify(block.input)}`); // i18n-ignore
        } else if (block.type === 'tool-result') {
            parts.push(`result:${block.output}`); // i18n-ignore
        } else if (block.type === 'image-ref') {
            parts.push(`image:${block.path ?? block.url ?? block.alt ?? ''}`); // i18n-ignore
        }
    }
    return parts.join('|');
}
function stableStringify(value) {
    try {
        return typeof value === 'string' ? value : JSON.stringify(value);
    } catch  {
        return String(value);
    }
}
function supersedes(candidate, existing) {
    const candidateRank = NATIVE_CHAT_SOURCE_PRIORITY[candidate.source];
    const existingRank = NATIVE_CHAT_SOURCE_PRIORITY[existing.source];
    return candidateRank > existingRank;
}
function messageSortRank(message) {
    if (message.id === NATIVE_CHAT_STREAMING_ID) {
        return 1;
    }
    if (isPendingMessageId(message.id) || isLaunchPromptMessageId(message.id)) {
        return 2;
    }
    return 0;
}
export function compareMessages(a, b) {
    const ar = messageSortRank(a);
    const br = messageSortRank(b);
    if (ar !== br) {
        return ar - br;
    }
    return compareNativeChatMessagesByTime(a, b);
}
export function assembleNativeChatSession(input) {
    const { sources, sessionId, agent, status, error } = input;
    const ordered = [
        ...normalizeImageTranscriptMessages(sortForImageNormalization(sources.transcript ?? [])),
        ...sources.hook ?? [],
        ...normalizeImageTranscriptMessages(sortForImageNormalization(sources.scrape ?? []))
    ];
    const byId = new Map();
    const byTurn = new Map();
    for (const message of ordered){
        mergeOne(byId, byTurn, message);
    }
    const messages = Array.from(byId.values()).sort(compareMessages);
    const derivedStatus = messages.length === 0 ? 'empty' : 'ready';
    return {
        messages,
        status: status ?? derivedStatus,
        sessionId,
        agent,
        ...error ? {
            error
        } : {}
    };
}
export function sortForImageNormalization(messages) {
    const units = [];
    for(let index = 0; index < messages.length; index += 1){
        const message = messages[index];
        const companions = [];
        let prompt;
        if (isImageSourceUserTurn(message)) {
            let nextIndex = index;
            while(nextIndex < messages.length && messages[nextIndex]?.source === message.source && isImageSourceUserTurn(messages[nextIndex])){
                companions.push(messages[nextIndex]);
                nextIndex += 1;
            }
            const candidate = messages[nextIndex];
            if (candidate?.role === 'user' && candidate.source === message.source && hasImagePromptMarker(candidate)) {
                prompt = candidate;
                index = nextIndex;
            } else {
                companions.length = 0;
            }
        } else {
            const candidate = messages[index + 1];
            if (message.role === 'user' && hasImagePromptMarker(message) && candidate?.source === message.source && candidate.timestamp === message.timestamp && isImageSourceUserTurn(candidate)) {
                let nextIndex = index + 1;
                while(nextIndex < messages.length && messages[nextIndex]?.source === message.source && messages[nextIndex]?.timestamp === message.timestamp && isImageSourceUserTurn(messages[nextIndex])){
                    companions.push(messages[nextIndex]);
                    nextIndex += 1;
                }
                prompt = message;
                index = nextIndex - 1;
            }
        }
        const unitMessages = prompt ? [
            ...companions,
            prompt
        ] : [
            message
        ];
        units.push({
            messages: unitMessages,
            sortKey: prompt ?? message
        });
    }
    units.sort((a, b)=>compareMessages(a.sortKey, b.sortKey));
    const sorted = units.flatMap((unit)=>unit.messages);
    return sorted.every((message, index)=>message === messages[index]) ? messages : sorted;
}
export function mergeOne(byId, byTurn, message) {
    const existingById = byId.get(message.id);
    if (existingById) {
        if (supersedes(message, existingById)) {
            replace(byId, byTurn, existingById, message);
        }
        return;
    }
    const key = turnKey(message);
    const existingByTurn = byTurn.get(key);
    if (existingByTurn && existingByTurn.source !== message.source) {
        if (supersedes(message, existingByTurn)) {
            replace(byId, byTurn, existingByTurn, message);
        }
        return;
    }
    byId.set(message.id, message);
    byTurn.set(key, message);
}
function replace(byId, byTurn, old, next) {
    byId.delete(old.id);
    byTurn.delete(turnKey(old));
    byId.set(next.id, next);
    byTurn.set(turnKey(next), next);
}
