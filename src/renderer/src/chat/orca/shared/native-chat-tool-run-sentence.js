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
// English fallback catalog; the renderer translates at the call site.
import { nativeChatToolCategory } from "./native-chat-tool-icon.js";
export const NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY = {
    read: {
        one: 'Read 1 file', // i18n-ignore
        many: 'Read {{value0}} files' // i18n-ignore
    },
    search: {
        one: 'Searched 1 time', // i18n-ignore
        many: 'Searched {{value0}} times' // i18n-ignore
    },
    listFiles: {
        one: 'Listed 1 directory', // i18n-ignore
        many: 'Listed {{value0}} directories' // i18n-ignore
    },
    unknown: {
        one: 'Ran 1 command', // i18n-ignore
        many: 'Ran {{value0}} commands' // i18n-ignore
    },
    fileChange: {
        one: 'Edited 1 file', // i18n-ignore
        many: 'Edited {{value0}} files' // i18n-ignore
    },
    webSearch: {
        one: 'Searched the web 1 time', // i18n-ignore
        many: 'Searched the web {{value0}} times' // i18n-ignore
    },
    mcpToolCall: {
        one: 'Used 1 integration', // i18n-ignore
        many: 'Used {{value0}} integrations' // i18n-ignore
    },
    subAgentActivity: {
        one: 'Ran 1 agent', // i18n-ignore
        many: 'Ran {{value0}} agents' // i18n-ignore
    },
    todoList: {
        one: 'Updated the plan', // i18n-ignore
        many: 'Updated the plan {{value0}} times' // i18n-ignore
    },
    other: {
        one: 'Used 1 tool', // i18n-ignore
        many: 'Used {{value0}} tools' // i18n-ignore
    }
};
export const NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS = {
    pair: '{{value0}} and {{value1}}',
    list: '{{value0}}, and {{value1}}'
};
export function nativeChatToolRunClauses(calls) {
    const counts = new Map();
    for (const call of calls){
        const category = nativeChatToolCategory(call.name, call.mcpIdentity) ?? 'other';
        counts.set(category, (counts.get(category) ?? 0) + 1);
    }
    return [
        ...counts
    ].map(([category, count])=>({
            category,
            count
        }));
}
export function joinNativeChatToolRunClauses(clauses, format) {
    const continued = clauses.map((clause, index)=>index === 0 || clause.length === 0 ? clause : `${clause[0].toLocaleLowerCase()}${clause.slice(1)}`);
    if (continued.length === 0) {
        return '';
    }
    if (continued.length === 1) {
        return continued[0];
    }
    if (continued.length === 2) {
        return format.pair(continued[0], continued[1]);
    }
    return format.list(continued.slice(0, -1).join(', '), continued.at(-1) ?? '');
}
export function formatNativeChatToolRunSentence(calls) {
    const rendered = nativeChatToolRunClauses(calls).map(({ category, count })=>{
        const copy = NATIVE_CHAT_TOOL_RUN_SENTENCE_COPY[category];
        return count === 1 ? copy.one : copy.many.replaceAll('{{value0}}', String(count));
    });
    return joinNativeChatToolRunClauses(rendered, {
        pair: (first, second)=>NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.pair.replaceAll('{{value0}}', first).replaceAll('{{value1}}', second),
        list: (leading, last)=>NATIVE_CHAT_TOOL_RUN_SENTENCE_JOINERS.list.replaceAll('{{value0}}', leading).replaceAll('{{value1}}', last)
    });
}
