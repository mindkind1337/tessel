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
import { isRootAgentJournalItem } from "./agent-session-journal-producer.js";
import { readAgentJournalTurn } from "./agent-session-turn-record.js";
import { isRunningStructuredAgentSessionToolAction, isStructuredAgentSessionToolAction, structuredAgentSessionToolCallBlock } from "./structured-agent-session-tool-call-block.js";
export function activeStructuredAgentSessionTurnId(items) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const turn = readAgentJournalTurn(items[index]?.body);
        if (turn) {
            return turn.state === 'running' ? turn.turnId : null;
        }
    }
    return null;
}
export function newestStructuredAgentSessionTurnBySequence(items) {
    let newestSequence = 0;
    let newest = null;
    for (const item of items){
        if (item.sequence < newestSequence) {
            continue;
        }
        const turn = readAgentJournalTurn(item.body);
        if (turn) {
            newestSequence = item.sequence;
            newest = turn;
        }
    }
    return newest;
}
export function activeStructuredAgentSessionTurnIdBySequence(items) {
    const newest = newestStructuredAgentSessionTurnBySequence(items);
    return newest?.state === 'running' ? newest.turnId : null;
}
export function newestStructuredAgentSessionTurn(items) {
    for(let index = items.length - 1; index >= 0; index -= 1){
        const turn = readAgentJournalTurn(items[index]?.body);
        if (turn) {
            return turn;
        }
    }
    return null;
}
export function isStructuredAgentSessionThinking(items) {
    let newestContentIsReasoning = null;
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        const body = item?.body;
        const turn = readAgentJournalTurn(body);
        if (turn) {
            return turn.state === 'running' && newestContentIsReasoning === true;
        }
        if (newestContentIsReasoning !== null || !isRootAgentJournalItem(item)) {
            continue;
        }
        if (body?.kind === 'message') {
            newestContentIsReasoning = body.role === 'reasoning';
        } else if (body?.kind === 'tool-call' || body?.kind === 'diff' || body?.kind === 'approval' || body?.kind === 'question') {
            newestContentIsReasoning = false;
        }
    }
    return false;
}
export function statusStructuredAgentSessionToolCall(items) {
    let newest = null;
    let running = null;
    for(let index = items.length - 1; index >= 0; index -= 1){
        const item = items[index];
        const body = item?.body;
        const turn = readAgentJournalTurn(body);
        if (turn) {
            const named = turn.state === 'running' ? running ?? newest : null;
            return named ? structuredAgentSessionToolCallBlock(named) : null;
        }
        if (running || !isStructuredAgentSessionToolAction(body) || !isRootAgentJournalItem(item)) {
            continue;
        }
        newest ??= body;
        if (isRunningStructuredAgentSessionToolAction(body)) {
            running = body;
        }
    }
    return null;
}
