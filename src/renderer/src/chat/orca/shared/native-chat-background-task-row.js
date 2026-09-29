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
// Protocol/recognition text stays English; translate only at the display boundary.
import { isBackgroundTaskBlock } from "./native-chat-types.js";
const IN_FLIGHT_TASK_STATES = new Set([
    'working',
    'monitoring',
    'waiting'
]);
const LATCHED_TASK_STATES = new Set([
    'done',
    'blocked',
    'idle'
]);
const KNOWN_TASK_STATES = [
    'working',
    'monitoring',
    'waiting',
    'blocked',
    'done',
    'idle',
    'unverifiable'
];
export function normalizeBackgroundTaskState(state) {
    return KNOWN_TASK_STATES.find((known)=>known === state) ?? 'unverifiable';
}
export function isSettledBackgroundTaskState(state) {
    return !IN_FLIGHT_TASK_STATES.has(state);
}
export function canReplaceBackgroundTaskState(current, next) {
    if (!isSettledBackgroundTaskState(current)) {
        return true;
    }
    if (LATCHED_TASK_STATES.has(current)) {
        return false;
    }
    return LATCHED_TASK_STATES.has(next);
}
const KNOWN_TASK_KINDS = [
    'agent',
    'workflow',
    'command',
    'monitor',
    'unknown'
];
export function normalizeBackgroundTaskKind(kind) {
    return KNOWN_TASK_KINDS.find((known)=>known === kind) ?? 'unknown';
}
const KIND_NOUNS = {
    agent: 'background agent',
    workflow: 'background workflow',
    command: 'background command',
    monitor: 'background monitor',
    unknown: 'background task'
};
const SETTLED_VERBS = {
    done: 'finished',
    blocked: 'failed',
    idle: 'was stopped'
};
export function backgroundTaskFallbackText(block) {
    const sentence = block.summary?.trim() || block.error?.trim();
    if (sentence) {
        return sentence;
    }
    const noun = KIND_NOUNS[normalizeBackgroundTaskKind(block.kind)];
    const subject = block.label.trim() ? `${noun} "${block.label}"` : noun;
    if (!isSettledBackgroundTaskState(block.state)) {
        return `Started ${subject}` /* i18n-ignore */; // i18n-ignore
    }
    const verb = SETTLED_VERBS[block.state] ?? 'stopped reporting';
    return `${subject.charAt(0).toUpperCase()}${subject.slice(1)} ${verb}`;
}
export function backgroundTaskBlocks(blocks) {
    return blocks.filter(isBackgroundTaskBlock);
}
export function claimBackgroundTaskTwins(blocks) {
    const twinTextIndexes = new Set();
    const unpairedRows = new Map();
    const wanted = new Map();
    const rows = [];
    blocks.forEach((block, index)=>{
        if (isBackgroundTaskBlock(block)) {
            const sentence = backgroundTaskFallbackText(block);
            rows.push({
                index,
                sentence
            });
            wanted.set(sentence, (wanted.get(sentence) ?? 0) + 1);
        }
    });
    for (const [index, block] of blocks.entries()){
        const count = block.type === 'text' ? wanted.get(block.text) ?? 0 : 0;
        if (block.type === 'text' && count > 0) {
            wanted.set(block.text, count - 1);
            twinTextIndexes.add(index);
        }
    }
    for (const row of rows){
        const count = wanted.get(row.sentence) ?? 0;
        if (count > 0) {
            wanted.set(row.sentence, count - 1);
            unpairedRows.set(row.index, row.sentence);
        }
    }
    return {
        twinTextIndexes,
        unpairedRows
    };
}
