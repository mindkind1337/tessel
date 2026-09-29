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
import { formatNativeChatDuration } from "./native-chat-turn-status.js";
export function toolExecutionMetadata(item) {
    const durationMs = item.durationMs ?? item.duration_ms;
    return {
        ...typeof item.exitCode === 'number' && Number.isSafeInteger(item.exitCode) ? {
            exitCode: item.exitCode
        } : {},
        ...typeof durationMs === 'number' && Number.isFinite(durationMs) && durationMs >= 0 ? {
            durationMs
        } : {}
    };
}
export function formatToolDuration(durationMs, formatMilliseconds = (value)=>`${value}ms`) {
    if (typeof durationMs !== 'number' || !Number.isFinite(durationMs) || durationMs < 0) {
        return null;
    }
    return durationMs < 1000 ? formatMilliseconds(Math.round(durationMs)) : formatNativeChatDuration(durationMs / 1000);
}
export function mcpToolIdentity(name, identity) {
    const match = /^mcp__([^\s]+?)__(\S+)$/.exec(name.trim());
    const server = identity?.server ?? match?.[1];
    const tool = identity?.tool ?? match?.[2];
    if (!server || !tool) {
        return null;
    }
    const label = server.replace(/[_-]+/g, ' ');
    return {
        server: label.charAt(0).toUpperCase() + label.slice(1),
        tool: tool.replace(/[_-]+/g, ' ')
    };
}
export const MAX_TOOL_SEARCH_RESULTS = 5;
const MAX_SEARCH_RESULT_SCAN = 100;
const MAX_SEARCH_URL_LENGTH = 2048;
const MAX_SEARCH_TITLE_LENGTH = 200;
export function toolWebSearchResults(value) {
    if (!Array.isArray(value)) {
        return [];
    }
    const results = [];
    const seen = new Set();
    for (const entry of value.slice(0, MAX_SEARCH_RESULT_SCAN)){
        if (!entry || typeof entry !== 'object' || typeof entry.url !== 'string') {
            continue;
        }
        const url = entry.url.trim();
        if (url.length > MAX_SEARCH_URL_LENGTH || !/^https?:\/\//i.test(url)) {
            continue;
        }
        try {
            const parsed = new URL(url);
            if (!parsed.hostname || parsed.username || parsed.password || seen.has(parsed.href)) {
                continue;
            }
            seen.add(parsed.href);
        } catch  {
            continue;
        }
        const title = typeof entry.title === 'string' ? entry.title.trim() : '';
        results.push({
            title: title.slice(0, MAX_SEARCH_TITLE_LENGTH) || url,
            url
        });
        if (results.length === MAX_TOOL_SEARCH_RESULTS) {
            break;
        }
    }
    return results;
}
