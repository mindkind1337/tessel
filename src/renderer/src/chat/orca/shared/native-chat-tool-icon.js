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
import { mcpToolIdentity } from "./native-chat-tool-identity.js";
import { EDIT_TOOL_NAMES } from "./native-chat-diff.js";
import { isCommandToolName } from "./native-chat-tool-activity.js";
import { toolInputCommand } from "./native-chat-tool-summary.js";
export const NATIVE_CHAT_TOOL_ICON_NAMES = {
    read: 'eye',
    search: 'search',
    listFiles: 'folder',
    unknown: 'square-terminal',
    fileChange: 'pencil',
    webSearch: 'globe',
    mcpToolCall: 'plug',
    subAgentActivity: 'bot',
    todoList: 'list-checks',
    other: 'wrench'
};
const CATEGORY_BY_ROW_WORD = new Map([
    [
        'read',
        'read'
    ],
    [
        'search',
        'search'
    ],
    [
        'list',
        'listFiles'
    ],
    [
        'exec',
        'unknown'
    ],
    [
        'local_shell',
        'unknown'
    ],
    [
        'diff',
        'fileChange'
    ],
    [
        'grep',
        'search'
    ],
    [
        'glob',
        'search'
    ],
    [
        'task',
        'subAgentActivity'
    ],
    [
        'webfetch',
        'webSearch'
    ],
    [
        'todowrite',
        'todoList'
    ],
    [
        'update_plan',
        'todoList'
    ],
    [
        'web search',
        'webSearch'
    ],
    [
        'websearch',
        'webSearch'
    ],
    [
        'web_search',
        'webSearch'
    ]
]);
const EDIT_ROW_WORDS = new Set([
    ...EDIT_TOOL_NAMES
].map((name)=>name.toLowerCase()));
const MCP_TOOL_PREFIX = 'mcp__';
export function nativeChatToolCategory(rowWord, mcpIdentity) {
    const word = rowWord.trim().toLowerCase();
    if (word.startsWith(MCP_TOOL_PREFIX) || mcpToolIdentity(rowWord, mcpIdentity) !== null) {
        return 'mcpToolCall';
    }
    if (isCommandToolName(word)) {
        return 'unknown';
    }
    return CATEGORY_BY_ROW_WORD.get(word) ?? (EDIT_ROW_WORDS.has(word) ? 'fileChange' : null);
}
export function nativeChatToolIconName(rowWord, mcpIdentity) {
    return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolCategory(rowWord, mcpIdentity) ?? 'other'];
}
export function nativeChatToolRunCategory(calls) {
    let shared = null;
    for (const call of calls){
        const category = nativeChatToolCategory(call.name, call.mcpIdentity) ?? 'other';
        if (shared !== null && shared !== category) {
            return null;
        }
        shared = category;
    }
    return shared;
}
export function nativeChatToolRunIconName(calls) {
    if (calls.length === 0) {
        return null;
    }
    return NATIVE_CHAT_TOOL_ICON_NAMES[nativeChatToolRunCategory(calls) ?? 'other'];
}
export function isShellActivityToolCall(call) {
    return isCommandToolName(call.name) || toolInputCommand(call.input) !== null;
}
