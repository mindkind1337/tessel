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
import { deriveNativeChatRowContent } from "./shared/native-chat-row-content.js";
const LINE_HEIGHT_PX = 22;
const CHARS_PER_LINE = 96;
const PROSE_MIN_LINES = 1;
const USER_BUBBLE_CHROME_PX = 32;
const IMAGE_STRIP_PX = 88;
const TOOL_RUN_PX = 40;
const SUBAGENT_ROW_PX = 32;
const STATUS_ROW_PX = 28;
const TURN_DIFF_PX = 28;
const RECEIPT_PX = 56;
const ROW_MIN_PX = 24;
export const NATIVE_CHAT_ROW_GAP_PX = 20;
const ROW_MAX_PX = 1600;
export function estimateNativeChatTextLines(markdown) {
    if (markdown.length === 0) {
        return 0;
    }
    let lines = 0;
    let lineStart = 0;
    for(let index = 0; index <= markdown.length; index += 1){
        if (index === markdown.length || markdown[index] === '\n') {
            const length = index - lineStart;
            lines += Math.max(PROSE_MIN_LINES, Math.ceil(length / CHARS_PER_LINE));
            lineStart = index + 1;
        }
    }
    return lines;
}
const metricsCache = new WeakMap();
export function nativeChatRowContentMetrics(message) {
    const cached = metricsCache.get(message);
    if (cached) {
        return cached;
    }
    const content = deriveNativeChatRowContent(message.blocks);
    const metrics = {
        role: message.role,
        textLines: estimateNativeChatTextLines(content.markdown),
        imageCount: content.prose.filter((block)=>block.type === 'image-ref').length,
        toolCount: content.tools.length,
        subagentGroupCount: content.subagentGroups.length
    };
    metricsCache.set(message, metrics);
    return metrics;
}
export function estimateNativeChatRowHeight(content, chrome) {
    let partCount = 0;
    let height = 0;
    if (chrome.hasReceipt) {
        height = RECEIPT_PX;
        partCount = 1;
    } else if (chrome.folded === true) {
        height = content.subagentGroupCount * SUBAGENT_ROW_PX;
        partCount = height > 0 ? 1 : 0;
    } else {
        height = content.textLines * LINE_HEIGHT_PX;
        if (content.role === 'user' && content.textLines > 0) {
            height += USER_BUBBLE_CHROME_PX;
        }
        if (content.imageCount > 0) {
            height += IMAGE_STRIP_PX;
        }
        if (content.toolCount > 0) {
            height += TOOL_RUN_PX;
        }
        height += content.subagentGroupCount * SUBAGENT_ROW_PX;
        partCount = height > 0 ? 1 : 0;
    }
    if (chrome.hasStatus) {
        height += STATUS_ROW_PX;
        partCount += 1;
    }
    if (chrome.hasTurnDiff) {
        height += TURN_DIFF_PX;
        partCount += 1;
    }
    height += Math.max(0, partCount - 1) * NATIVE_CHAT_ROW_GAP_PX;
    return Math.min(ROW_MAX_PX, Math.max(ROW_MIN_PX, height));
}
