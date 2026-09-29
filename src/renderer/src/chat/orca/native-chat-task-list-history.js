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
import { nativeChatTaskListTool, normalizeNativeChatTaskList } from "./shared/native-chat-task-list.js";
import { pairToolBlocks } from "./native-chat-tool-fold.js";
function taskListFromCall(call) {
    return call.state === 'failed' ? null : normalizeNativeChatTaskList(call.name, call.input);
}
export function nativeChatTaskListPredecessors(messages) {
    const history = new Map();
    const previous = {};
    for (const message of messages){
        history.set(message.id, {
            ...previous
        });
        if (message.role === 'user') {
            continue;
        }
        for (const { call, result } of pairToolBlocks(message.blocks)){
            if (!call || result?.isError) {
                continue;
            }
            const tool = nativeChatTaskListTool(call.name);
            if (tool && taskListFromCall(call)) {
                previous[tool] = call;
            }
        }
    }
    return history;
}
export function buildNativeChatTaskListRows(blocks, predecessors = {}) {
    const rows = new Map();
    const consumedResults = new Set();
    const previous = new Map();
    for (const call of Object.values(predecessors)){
        if (!call) {
            continue;
        }
        const tool = nativeChatTaskListTool(call.name);
        const list = taskListFromCall(call);
        if (tool && list) {
            previous.set(tool, list);
        }
    }
    for (const { call, result } of pairToolBlocks(blocks)){
        if (!call || result?.isError) {
            continue;
        }
        const tool = nativeChatTaskListTool(call.name);
        const list = taskListFromCall(call);
        if (!tool || !list) {
            continue;
        }
        rows.set(call, {
            list,
            previous: previous.get(tool)
        });
        previous.set(tool, list);
        if (result) {
            consumedResults.add(result);
        }
    }
    return {
        rows,
        consumedResults
    };
}
