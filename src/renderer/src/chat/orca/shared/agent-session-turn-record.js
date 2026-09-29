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
import { AGENT_JOURNAL_TURN_OUTCOMES } from "./agent-session-journal-types.js";
import { agentTurnLifecycleText } from "./agent-turn-lifecycle-text.js";
export function readAgentJournalTurn(body) {
    if (!body) {
        return null;
    }
    if (body.kind === 'turn') {
        const { kind: _kind, ...turn } = body;
        return turn;
    }
    return body.kind === 'status' ? body.turnLifecycle ?? null : null;
}
export function isRunningAgentJournalTurn(body) {
    return readAgentJournalTurn(body)?.state === 'running';
}
export function readAgentJournalTurnOutcome(turn) {
    const outcome = turn?.outcome;
    return AGENT_JOURNAL_TURN_OUTCOMES.find((known)=>known === outcome) ?? null;
}
export function agentJournalTurnBody(turn) {
    return {
        kind: 'turn',
        ...turn
    };
}
export function legacyAgentJournalTurnStatusBody(turn, itemId) {
    const agent = itemId.startsWith('legacy:claude:') ? 'Claude' : 'Codex';
    return {
        kind: 'status',
        text: agentTurnLifecycleText(agent, turn.state),
        turnLifecycle: turn
    };
}
