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
import { formatNativeChatDuration } from "./shared/native-chat-turn-status.js";
import { t } from "../../i18n/index.js";
const KIND_ORDER = [
    'agent',
    'command',
    'monitor',
    'workflow',
    'unknown'
];
const PLACEHOLDER_NAMES = new Set([
    'unknown',
    'untitled',
    'task',
    'subagent'
]);
function usableTaskText(value) {
    const trimmed = value?.trim();
    if (!trimmed || PLACEHOLDER_NAMES.has(trimmed.toLowerCase())) {
        return null;
    }
    return trimmed;
}
export function backgroundTaskKindLabel(kind) {
    switch(kind){
        case 'agent':
            return t('chat.orca.backgroundTasks.agent', 'Background agent');
        case 'workflow':
            return t('chat.orca.backgroundTasks.workflow', 'Background workflow');
        case 'command':
            return t('chat.orca.backgroundTasks.command', 'Background command');
        case 'monitor':
            return t('chat.orca.backgroundTasks.monitor', 'Background monitor');
        case 'unknown':
            return t('chat.orca.backgroundTasks.task', 'Background task');
    }
}
export function resolveBackgroundTaskName(task) {
    return usableTaskText(task.description) ?? usableTaskText(task.name) ?? backgroundTaskKindLabel(task.kind);
}
function effectiveState(task, settled) {
    if (task.state) {
        return task.state;
    }
    if (settled) {
        return 'done';
    }
    return task.kind === 'monitor' ? 'monitoring' : 'working';
}
export function buildBackgroundTaskGroups(tasks, settledTasks) {
    const owners = new Map();
    for (const [roster, settled] of [
        [
            settledTasks,
            true
        ],
        [
            tasks,
            false
        ]
    ]){
        for (const task of roster){
            owners.set(task.id, {
                task,
                settled,
                state: effectiveState(task, settled),
                name: resolveBackgroundTaskName(task)
            });
        }
    }
    const entries = [
        ...owners.values()
    ];
    entries.sort((left, right)=>{
        const startDelta = (left.task.startedAt ?? 0) - (right.task.startedAt ?? 0);
        return startDelta !== 0 ? startDelta : left.task.id < right.task.id ? -1 : 1;
    });
    return KIND_ORDER.map((kind)=>({
            kind,
            tasks: entries.filter((entry)=>entry.task.kind === kind)
        })).filter((group)=>group.tasks.length > 0);
}
export function backgroundTaskStateWord(state) {
    switch(state){
        case 'working':
            return t('chat.orca.backgroundTasks.stateWorking', 'working');
        case 'monitoring':
            return t('chat.orca.backgroundTasks.stateMonitoring', 'monitoring');
        case 'waiting':
            return t('chat.orca.backgroundTasks.stateWaiting', 'waiting');
        case 'blocked':
            return t('chat.orca.backgroundTasks.stateBlocked', 'blocked');
        case 'done':
            return t('chat.orca.backgroundTasks.stateDone', 'done');
        case 'idle':
            return t('chat.orca.backgroundTasks.stateIdle', 'stopped');
        case 'unverifiable':
            return t('chat.orca.backgroundTasks.stateUnverifiable', 'unverifiable');
    }
}
export function backgroundTaskStateReason(state) {
    switch(state){
        case 'waiting':
            return t('chat.orca.backgroundTasks.reasonWaiting', 'needs approval');
        case 'unverifiable':
            return t('chat.orca.backgroundTasks.reasonUnverifiable', 'no contact');
        case 'blocked':
            return t('chat.orca.backgroundTasks.reasonBlocked', 'failed');
        case 'working':
        case 'monitoring':
        case 'done':
        case 'idle':
            return null;
    }
}
function tokenScaleText(value) {
    return Number.isInteger(value) ? value.toFixed(0) : value.toFixed(1);
}
export function formatBackgroundTaskTokens(totalTokens) {
    if (totalTokens < 1_000) {
        return String(totalTokens);
    }
    const thousands = Math.round(totalTokens / 100) / 10;
    return thousands < 1_000 ? `${tokenScaleText(thousands)}k` : `${tokenScaleText(Math.round(totalTokens / 100_000) / 10)}m`;
}
export function backgroundTaskElapsedLabel(task, now) {
    if (task.startedAt === undefined || task.startedAt <= 0) {
        return null;
    }
    return formatNativeChatDuration((now - task.startedAt) / 1000);
}
export function backgroundTaskGroupLabel(kind) {
    switch(kind){
        case 'agent':
            return t('chat.orca.backgroundTasks.groupAgents', 'Agents');
        case 'command':
            return t('chat.orca.backgroundTasks.groupShell', 'Shell');
        case 'monitor':
            return t('chat.orca.backgroundTasks.groupMonitors', 'Monitors');
        case 'workflow':
            return t('chat.orca.backgroundTasks.groupWorkflows', 'Workflows');
        case 'unknown':
            return t('chat.orca.backgroundTasks.groupTasks', 'Tasks');
    }
}
