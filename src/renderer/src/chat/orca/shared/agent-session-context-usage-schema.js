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
import { z } from 'zod';
import { MAX_CONTEXT_CATEGORIES, MAX_CONTEXT_CATEGORY_NAME_CHARS, MAX_CONTEXT_MODEL_ID_CHARS } from "./agent-session-context-usage.js";
const TokenCount = z.number().finite().nonnegative();
const WindowTokens = z.number().finite().positive();
const CapturedAt = z.number().finite();
const ModelId = z.string().min(1).max(MAX_CONTEXT_MODEL_ID_CHARS);
const TokenUsage = z.object({
    inputTokens: TokenCount,
    cacheCreationInputTokens: TokenCount,
    cacheReadInputTokens: TokenCount,
    outputTokens: TokenCount
});
const Used = z.discriminatedUnion('kind', [
    z.object({
        kind: z.literal('report'),
        model: ModelId,
        usedTokens: TokenCount,
        windowTokens: WindowTokens,
        percentage: z.number().finite(),
        autoCompactAtTokens: TokenCount.optional(),
        categories: z.array(z.object({
            name: z.string().min(1).max(MAX_CONTEXT_CATEGORY_NAME_CHARS),
            tokens: TokenCount,
            deferred: z.literal(true).optional()
        })).max(MAX_CONTEXT_CATEGORIES),
        capturedAt: CapturedAt
    }),
    z.object({
        kind: z.literal('estimate'),
        usage: TokenUsage,
        capturedAt: CapturedAt
    }),
    z.object({
        kind: z.literal('unknown'),
        capturedAt: CapturedAt
    })
]);
export const AgentSessionContextUsageSchema = z.object({
    window: z.object({
        tokens: WindowTokens,
        capturedAt: CapturedAt
    }).optional(),
    used: Used.optional()
});
export function isAdmissibleAgentSessionContextUsage(value) {
    return AgentSessionContextUsageSchema.safeParse(value).success;
}
