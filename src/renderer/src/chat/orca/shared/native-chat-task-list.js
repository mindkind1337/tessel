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
export function nativeChatTaskListTool(name) {
    const normalized = name.trim().toLowerCase();
    return normalized === 'todowrite' || normalized === 'update_plan' ? normalized : null;
}
function record(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : null;
}
function nonemptyString(value) {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}
export function normalizeNativeChatTaskList(name, input) {
    const tool = nativeChatTaskListTool(name);
    if (!tool) {
        return null;
    }
    if (typeof input === 'string') {
        try {
            input = JSON.parse(input);
        } catch  {
            return null;
        }
    }
    const value = record(input);
    const entries = tool === 'todowrite' ? value?.todos : value?.plan;
    if (!Array.isArray(entries)) {
        return null;
    }
    const tasks = [];
    for (const entry of entries){
        const item = record(entry);
        const content = nonemptyString(tool === 'todowrite' ? item?.content : item?.step);
        if (!item || !content) {
            continue;
        }
        const status = item.status === 'in_progress' || tool === 'update_plan' && item.status === 'inProgress' ? 'in_progress' : item.status === 'completed' ? 'completed' : 'pending';
        const activeForm = tool === 'todowrite' ? nonemptyString(item.activeForm) : undefined;
        tasks.push({
            content,
            status,
            ...activeForm ? {
                activeForm
            } : {}
        });
    }
    if (entries.length > 0 && tasks.length === 0) {
        return null;
    }
    const explanation = tool === 'update_plan' ? nonemptyString(value?.explanation) : undefined;
    return {
        tasks,
        ...explanation ? {
            explanation
        } : {}
    };
}
export function nativeChatTaskLabel(task) {
    return task.status === 'in_progress' && task.activeForm ? task.activeForm : task.content;
}
export function diffNativeChatTaskLists(previous, current) {
    const byContent = new Map();
    for (const task of previous.tasks){
        const matches = byContent.get(task.content);
        if (matches) {
            matches.push(task);
        } else {
            byContent.set(task.content, [
                task
            ]);
        }
    }
    const occurrences = new Map();
    const consumed = new Set();
    const changes = [];
    for (const task of current.tasks){
        const occurrence = occurrences.get(task.content) ?? 0;
        occurrences.set(task.content, occurrence + 1);
        const before = byContent.get(task.content)?.[occurrence];
        if (!before) {
            changes.push({
                kind: 'added',
                task
            });
            continue;
        }
        consumed.add(before);
        if (before.status !== task.status) {
            changes.push({
                kind: task.status === 'completed' ? 'completed' : task.status === 'in_progress' ? 'started' : 'pending',
                task
            });
        } else if (before.activeForm !== task.activeForm) {
            changes.push({
                kind: 'updated',
                task
            });
        }
    }
    for (const task of previous.tasks){
        if (!consumed.has(task)) {
            changes.push({
                kind: 'removed',
                task
            });
        }
    }
    return changes;
}
