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
import { stripAnsiEscapeSequences, TERMINAL_CONTROL_CHARACTER_PATTERN } from "./ansi-escape-sequences.js";
import { isTextBlock } from "./native-chat-types.js";
const IMAGE_SOURCE_MARKER = /^\[Image:\s*source:\s*(.+?)\]\s*$/;
const IMAGE_PROMPT_MARKER = /\[Image #\d+\]/;
const IMAGE_PROMPT_MARKERS = /\[Image #\d+\]/g;
const IMAGE_PROMPT_MARKER_AT_START = /^[^\S\r\n]*\[Image #\d+\]/;
const IMAGE_PROMPT_MARKER_AT_END = /\[Image #\d+\][^\S\r\n]*$/;
const HORIZONTAL_WHITESPACE_START = /^[^\S\r\n]+/;
const HORIZONTAL_WHITESPACE_END = /[^\S\r\n]+$/;
export function imageSourcePathFromText(text) {
    return text.match(IMAGE_SOURCE_MARKER)?.[1]?.trim() ?? null;
}
export function imageSourcePathsFromMessage(message) {
    if (message.role !== 'user' || message.blocks.length === 0) {
        return [];
    }
    const paths = [];
    for (const block of message.blocks){
        if (!isTextBlock(block)) {
            return [];
        }
        const path = imageSourcePathFromText(block.text);
        if (path === null) {
            return [];
        }
        paths.push(path);
    }
    return paths;
}
export function isImageSourceUserTurn(message) {
    return imageSourcePathsFromMessage(message).length > 0;
}
export function stripImagePromptMarker(text) {
    const stripped = text.replace(IMAGE_PROMPT_MARKERS, '');
    if (stripped === text) {
        return text;
    }
    let result = IMAGE_PROMPT_MARKER_AT_START.test(text) ? stripped.replace(HORIZONTAL_WHITESPACE_START, '') : stripped;
    if (IMAGE_PROMPT_MARKER_AT_END.test(text)) {
        result = result.replace(HORIZONTAL_WHITESPACE_END, '');
    }
    return result;
}
export function normalizeNativeChatUserText(text) {
    return stripImagePromptMarker(stripAnsiEscapeSequences(text).replace(TERMINAL_CONTROL_CHARACTER_PATTERN, '')).trim().replace(/\s+/g, ' ');
}
export function normalizedNativeChatUserMessageText(message) {
    if (message.role !== 'user') {
        return null;
    }
    const normalized = normalizeNativeChatUserText(message.blocks.filter(isTextBlock).map((block)=>block.text).join(' '));
    return normalized || null;
}
function stripImagePromptMarkersFromTextBlocks(blocks) {
    let sawText = false;
    let next = null;
    for(let index = 0; index < blocks.length; index += 1){
        const block = blocks[index];
        if (!isTextBlock(block)) {
            next?.push(block);
            continue;
        }
        const isFirstText = !sawText;
        sawText = true;
        const text = stripImagePromptMarker(block.text);
        if (!text.trim() && (text !== block.text || isFirstText)) {
            next ??= blocks.slice(0, index);
            continue;
        }
        if (text !== block.text) {
            next ??= blocks.slice(0, index);
            next.push({
                ...block,
                text
            });
            continue;
        }
        next?.push(block);
    }
    return next ?? blocks;
}
export function hasImagePromptMarker(message) {
    return message.blocks.some((block)=>isTextBlock(block) && IMAGE_PROMPT_MARKER.test(block.text));
}
export function normalizeImageTranscriptMessages(messages) {
    let normalized = null;
    for(let index = 0; index < messages.length; index += 1){
        const message = messages[index];
        if (message.role !== 'user') {
            normalized?.push(message);
            continue;
        }
        const messageImagePaths = imageSourcePathsFromMessage(message);
        if (messageImagePaths.length > 0) {
            normalized ??= messages.slice(0, index);
            const imagePaths = [
                ...messageImagePaths
            ];
            let nextIndex = index + 1;
            while(nextIndex < messages.length){
                const candidate = messages[nextIndex];
                const candidatePaths = imageSourcePathsFromMessage(candidate);
                if (candidate.role !== 'user' || candidate.source !== message.source || candidatePaths.length === 0) {
                    break;
                }
                imagePaths.push(...candidatePaths);
                nextIndex += 1;
            }
            const prompt = messages[nextIndex];
            if (prompt?.role === 'user' && prompt.source === message.source && hasImagePromptMarker(prompt)) {
                normalized.push({
                    ...prompt,
                    blocks: [
                        ...imagePaths.map((path)=>({
                                type: 'image-ref',
                                path
                            })),
                        ...stripImagePromptMarkersFromTextBlocks(prompt.blocks)
                    ]
                });
                index = nextIndex;
                continue;
            }
            normalized.push({
                ...message,
                blocks: messageImagePaths.map((path)=>({
                        type: 'image-ref',
                        path
                    }))
            });
            continue;
        }
        const blocks = stripImagePromptMarkersFromTextBlocks(message.blocks);
        if (blocks === message.blocks) {
            normalized?.push(message);
        } else {
            normalized ??= messages.slice(0, index);
            normalized.push({
                ...message,
                blocks
            });
        }
    }
    return normalized ?? messages;
}
