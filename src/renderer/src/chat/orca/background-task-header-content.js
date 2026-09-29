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
import { t } from "../../i18n/index.js";
import { backgroundTaskElapsedLabel, backgroundTaskStateReason, backgroundTaskStateWord } from "./background-task-roster.js";
function kindCountLabel(kind, count) {
    const value = {
        value0: count
    };
    switch(kind){
        case 'agent':
            return count === 1 ? t('chat.orca.backgroundTasks.countAgentsOne', '1 agent') : t('chat.orca.backgroundTasks.countAgentsMany', '{{value0}} agents', value);
        case 'command':
            return count === 1 ? t('chat.orca.backgroundTasks.countShellOne', '1 shell') : t('chat.orca.backgroundTasks.countShellMany', '{{value0}} shells', value);
        case 'monitor':
            return count === 1 ? t('chat.orca.backgroundTasks.countMonitorsOne', '1 monitor') : t('chat.orca.backgroundTasks.countMonitorsMany', '{{value0}} monitors', value);
        case 'workflow':
            return count === 1 ? t('chat.orca.backgroundTasks.countWorkflowsOne', '1 workflow') : t('chat.orca.backgroundTasks.countWorkflowsMany', '{{value0}} workflows', value);
        case 'unknown':
            return count === 1 ? t('chat.orca.backgroundTasks.countTasksOne', '1 task') : t('chat.orca.backgroundTasks.countTasksMany', '{{value0}} tasks', value);
    }
}
const HEADER_SEGMENT_CAP = 3;
const HEADER_STATE_ORDER = [
    'working',
    'monitoring',
    'waiting',
    'blocked',
    'unverifiable',
    'idle',
    'done'
];
const ATTENTION_STATES = new Set([
    'waiting',
    'unverifiable',
    'blocked'
]);
export function backgroundTasksHeaderContent(groups, options) {
    const all = groups.flatMap((group)=>group.tasks);
    if (all.length === 0) {
        return {
            segments: [],
            detail: t('chat.orca.backgroundTasks.monitoring', 'Monitoring background tasks')
        };
    }
    if (groups.length > HEADER_SEGMENT_CAP || options.narrow && all.length > 1) {
        return {
            segments: [
                {
                    text: t('chat.orca.backgroundTasks.headerTotal', '{{value0}} background tasks', {
                        value0: all.length
                    }),
                    kind: null
                }
            ],
            detail: null
        };
    }
    if (groups.length > 1) {
        return {
            segments: groups.map((group)=>({
                    text: kindCountLabel(group.kind, group.tasks.length),
                    kind: group.kind
                })),
            detail: null
        };
    }
    const group = groups[0];
    const count = group.tasks.length;
    const uniformState = group.tasks.every((entry)=>entry.state === group.tasks[0].state) ? group.tasks[0].state : null;
    if (uniformState && ATTENTION_STATES.has(uniformState)) {
        return {
            segments: [
                {
                    text: `${kindCountLabel(group.kind, count)} ${backgroundTaskStateWord(uniformState)}`,
                    kind: group.kind
                }
            ],
            detail: backgroundTaskStateReason(uniformState)
        };
    }
    if (count === 1) {
        const entry = group.tasks[0];
        const subject = group.kind === 'command' ? t('chat.orca.backgroundTasks.countShellCommandOne', '1 shell command') : kindCountLabel(group.kind, 1);
        const elapsed = group.kind === 'command' && !entry.settled ? backgroundTaskElapsedLabel(entry.task, options.now) : null;
        return {
            segments: [
                {
                    text: subject,
                    kind: group.kind
                }
            ],
            detail: elapsed ?? backgroundTaskStateWord(entry.state)
        };
    }
    const stateCounts = HEADER_STATE_ORDER.map((state)=>({
            state,
            count: group.tasks.filter((entry)=>entry.state === state).length
        })).filter((entry)=>entry.count > 0);
    return {
        segments: [
            {
                text: kindCountLabel(group.kind, count),
                kind: group.kind
            }
        ],
        detail: stateCounts.length > 0 ? stateCounts.map((entry)=>`${entry.count} ${backgroundTaskStateWord(entry.state)}`).join(', ') : null
    };
}
