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
function rowPercentage(tokens, windowTokens) {
    return windowTokens > 0 ? Math.round(tokens / windowTokens * 1000) / 10 : 0;
}
export function summarizeContextUsage(usage) {
    return {
        usedTokens: usage.usedTokens,
        windowTokens: usage.windowTokens,
        percentage: usage.percentage,
        estimated: usage.estimated,
        rows: usage.categories.filter((row)=>row.tokens > 0).map((row)=>({
                name: row.name,
                tokens: row.tokens,
                percentage: rowPercentage(row.tokens, usage.windowTokens)
            })).sort((left, right)=>right.tokens - left.tokens)
    };
}
export function formatContextTokenCount(tokens) {
    const safe = Math.max(0, tokens);
    if (Math.round(safe / 100) >= 10_000) {
        return `${trimZero((safe / 1_000_000).toFixed(1))}M`;
    }
    if (safe >= 1_000) {
        return `${trimZero((safe / 1_000).toFixed(1))}k`;
    }
    return String(Math.round(safe));
}
function trimZero(value) {
    return value.endsWith('.0') ? value.slice(0, -2) : value;
}
