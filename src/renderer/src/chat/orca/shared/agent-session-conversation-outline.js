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
import { deriveNativeChatRowContent, nativeChatRowRendersContent } from "./native-chat-row-content.js";
import { projectStructuredAgentSessionMessages } from "./structured-agent-session-message-projection.js";
import { projectNativeChatTranscriptMessages } from "./native-chat-transcript-projection.js";
export const AGENT_SESSION_OUTLINE_PREVIEW_MAX_CHARS = 200;
const previews = new WeakMap();
export function nativeChatUserMessagePreview(blocks) {
    const cached = previews.get(blocks);
    if (cached) {
        return cached;
    }
    const content = deriveNativeChatRowContent(blocks);
    const preview = {
        text: content.markdown.replace(/\s+/g, ' ').trim(),
        imageCount: content.prose.filter((block)=>block.type === 'image-ref').length
    };
    previews.set(blocks, preview);
    return preview;
}
export function truncateOutlinePreview(text, maxChars) {
    if (text.length <= maxChars) {
        return text;
    }
    const last = text.charCodeAt(maxChars - 1);
    const end = last >= 0xd800 && last <= 0xdbff ? maxChars - 1 : maxChars;
    return text.slice(0, end).trimEnd();
}
export function projectAgentSessionConversationOutline(items, submissions) {
    const sequences = new Map();
    for (const item of items){
        if (item.body.kind === 'message' && item.body.role === 'user') {
            sequences.set(item.itemId, item.sequence);
        }
    }
    const entries = [];
    const transcript = projectNativeChatTranscriptMessages(projectStructuredAgentSessionMessages(items, [], submissions));
    for (const message of transcript){
        const sequence = sequences.get(message.id);
        if (sequence === undefined || message.role !== 'user' || !nativeChatRowRendersContent(message.blocks)) {
            continue;
        }
        const preview = nativeChatUserMessagePreview(message.blocks);
        entries.push({
            itemId: message.id,
            sequence,
            preview: preview.text,
            imageCount: preview.imageCount
        });
    }
    return entries;
}
