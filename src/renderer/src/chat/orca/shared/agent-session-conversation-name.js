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
import { sliceAtCodeUnitLimit } from "./surrogate-safe-text-slice.js";
export const AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH = 200;
const UNRENDERABLE_RUN = /(?:[\s\p{Cc}\p{Zl}\p{Zp}]|(?![\u200C\u200D])\p{Cf})+/gu;
const BLANK_ONLY = /^[\s\u200C\u200D]+$/u;
const LONE_SURROGATE = /[\uD800-\uDFFF]/gu;
const TRAILING_DANGLE = /[\s\u200C\u200D]+$/u;
export function normalizeAgentSessionConversationName(value) {
    if (typeof value !== 'string') {
        return null;
    }
    const collapsed = value.replace(LONE_SURROGATE, '').replace(UNRENDERABLE_RUN, ' ').trim();
    if (!collapsed || BLANK_ONLY.test(collapsed)) {
        return null;
    }
    if (collapsed.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH) {
        return collapsed;
    }
    const truncated = sliceAtCodeUnitLimit(collapsed, AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH).replace(TRAILING_DANGLE, '');
    return truncated || null;
}
export function isAgentSessionConversationName(value) {
    return typeof value === 'string' && value.length > 0 && value.length <= AGENT_SESSION_CONVERSATION_NAME_MAX_LENGTH && normalizeAgentSessionConversationName(value) === value;
}
