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
import { isSubagentGroupBlock } from "./native-chat-types.js";
const TERMINAL_SUBAGENT_STATES = new Set([
    'idle',
    'completed',
    'failed',
    'stopped',
    'unverifiable'
]);
const SETTLED_PRECEDENCE = [
    'failed',
    'stopped',
    'unverifiable',
    'idle',
    'completed'
];
const ADVERSE_PRECEDENCE = [
    'failed',
    'stopped',
    'unverifiable'
];
export function normalizeSubagentState(state) {
    if (state === 'working') {
        return 'working';
    }
    return TERMINAL_SUBAGENT_STATES.has(state) ? state : 'unverifiable';
}
export const MAX_SUBAGENT_FIELD_CHARS = 512;
export function isTerminalSubagentState(state) {
    return normalizeSubagentState(state) !== 'working';
}
const LATCHED_SUBAGENT_STATES = new Set([
    'idle',
    'completed',
    'failed',
    'stopped'
]);
export function canReplaceSubagentState(current, next) {
    const from = normalizeSubagentState(current);
    if (from === 'working') {
        return true;
    }
    if (LATCHED_SUBAGENT_STATES.has(from)) {
        return false;
    }
    return LATCHED_SUBAGENT_STATES.has(normalizeSubagentState(next));
}
export function summarizeSubagentGroup(agents) {
    const counts = new Map();
    let working = 0;
    let tokens = null;
    let startedAt = null;
    let settledAt = null;
    for (const agent of agents){
        const state = normalizeSubagentState(agent.state);
        if (state === 'working') {
            working += 1;
        } else {
            counts.set(state, (counts.get(state) ?? 0) + 1);
        }
        if (typeof agent.tokens === 'number' && Number.isFinite(agent.tokens)) {
            tokens = (tokens ?? 0) + agent.tokens;
        }
        if (typeof agent.startedAt === 'number') {
            startedAt = startedAt === null ? agent.startedAt : Math.min(startedAt, agent.startedAt);
        }
        if (typeof agent.settledAt === 'number') {
            settledAt = settledAt === null ? agent.settledAt : Math.max(settledAt, agent.settledAt);
        }
    }
    const settledState = working > 0 ? null : SETTLED_PRECEDENCE.find((state)=>counts.has(state)) ?? null;
    const adverseState = ADVERSE_PRECEDENCE.find((state)=>counts.has(state)) ?? null;
    return {
        total: agents.length,
        working,
        settledState,
        settledCount: settledState === null ? 0 : counts.get(settledState) ?? 0,
        adverseState,
        adverseCount: adverseState === null ? 0 : counts.get(adverseState) ?? 0,
        tokens,
        startedAt,
        settledAt: working > 0 ? null : settledAt
    };
}
export function isRenderableSubagentGroup(block) {
    return block.agents.length > 0;
}
export function subagentGroupBlocks(blocks) {
    return blocks.filter((block)=>isSubagentGroupBlock(block) && isRenderableSubagentGroup(block));
}
export function subagentGroupFallbackText(agents) {
    const { total, working, adverseState, adverseCount } = summarizeSubagentGroup(agents);
    const noun = total === 1 ? 'subagent' : 'subagents';
    const adverse = adverseState === null ? '' : ` (${adverseCount} ${adverseState})`;
    return `${working > 0 ? 'Kicked off' : 'Ran'} ${total} ${noun}${adverse}`;
}
const SUBAGENT_GROUP_FALLBACK_PATTERN = /^(?:Kicked off \d+ subagents?(?: — \d+ working)?|Ran \d+ subagents?)(?: \(\d+ [a-z][a-z-]*\))?$/;
export function isSubagentGroupFallbackText(text) {
    return SUBAGENT_GROUP_FALLBACK_PATTERN.test(text);
}
