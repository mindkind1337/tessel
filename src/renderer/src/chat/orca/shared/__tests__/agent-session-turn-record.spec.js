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
import { describe, expect, it } from 'vitest';
import { AGENT_SESSION_JOURNAL_SCHEMA_VERSION, journalRowSchemaVersion } from "../agent-session-journal-types.js";
import { agentJournalTurnBody, isRunningAgentJournalTurn, legacyAgentJournalTurnStatusBody, readAgentJournalTurn, readAgentJournalTurnOutcome } from "../agent-session-turn-record.js";
const turn = {
    turnId: 't1',
    state: 'completed',
    userItemId: 'codex:thread:t1:0',
    startedAt: 1_000,
    completedAt: 8_200,
    durationMs: 7_172
};
describe('readAgentJournalTurn', ()=>{
    it('reads the typed item and the legacy status form alike', ()=>{
        expect(readAgentJournalTurn(agentJournalTurnBody(turn))).toEqual(turn);
        expect(readAgentJournalTurn({
            kind: 'status',
            text: 'x',
            turnLifecycle: turn
        })).toEqual(turn);
    });
    it('reads nothing off other bodies', ()=>{
        expect(readAgentJournalTurn({
            kind: 'status',
            text: 'Conversation compacted.'
        })).toBeNull();
        expect(readAgentJournalTurn({
            kind: 'message',
            role: 'user',
            blocks: [
                {
                    type: 'text',
                    text: 'hi'
                }
            ]
        })).toBeNull();
        expect(readAgentJournalTurn(undefined)).toBeNull();
    });
    it('answers the running check for either form', ()=>{
        expect(isRunningAgentJournalTurn(agentJournalTurnBody({
            ...turn,
            state: 'running'
        }))).toBe(true);
        expect(isRunningAgentJournalTurn({
            kind: 'status',
            text: 'x',
            turnLifecycle: turn
        })).toBe(false);
    });
});
describe('readAgentJournalTurnOutcome', ()=>{
    it.each([
        'success',
        'failure',
        'cancellation'
    ])('reads a %s verdict off either journal shape', (outcome)=>{
        const withOutcome = {
            ...turn,
            outcome
        };
        expect(readAgentJournalTurnOutcome(readAgentJournalTurn(agentJournalTurnBody(withOutcome)))).toBe(outcome);
        expect(readAgentJournalTurnOutcome(readAgentJournalTurn({
            kind: 'status',
            text: 'x',
            turnLifecycle: withOutcome
        }))).toBe(outcome);
    });
    it('never reads an old host completed row as success', ()=>{
        expect(readAgentJournalTurnOutcome(turn)).toBeNull();
        expect(readAgentJournalTurnOutcome({
            turnId: 't',
            state: 'completed'
        })).toBeNull();
        expect(readAgentJournalTurnOutcome(readAgentJournalTurn({
            kind: 'status',
            text: 'Claude turn completed',
            turnLifecycle: turn
        }))).toBeNull();
    });
    it('reads a verdict from a later vocabulary as unknown rather than an arm', ()=>{
        expect(readAgentJournalTurnOutcome({
            ...turn,
            outcome: 'partially-refused'
        })).toBeNull();
    });
    it('answers unknown for a body that carries no turn at all', ()=>{
        expect(readAgentJournalTurnOutcome(null)).toBeNull();
        expect(readAgentJournalTurnOutcome(undefined)).toBeNull();
        expect(readAgentJournalTurnOutcome(readAgentJournalTurn({
            kind: 'status',
            text: 'compacted'
        }))).toBeNull();
    });
});
describe('legacyAgentJournalTurnStatusBody', ()=>{
    it('names the agent from the lifecycle identity and never calls an unobserved end completed', ()=>{
        expect(legacyAgentJournalTurnStatusBody(turn, 'legacy:claude:s:turn-lifecycle%3At1')).toEqual({
            kind: 'status',
            text: 'Claude turn completed',
            turnLifecycle: turn
        });
        expect(legacyAgentJournalTurnStatusBody({
            turnId: 't2',
            state: 'unverifiable',
            startedAt: 1
        }, 'legacy:codex:s:turn-lifecycle%3At2').text).toBe('Codex turn outcome unverifiable');
    });
    it('carries the verdict to a client that predates the turn item', ()=>{
        const failed = {
            ...turn,
            outcome: 'failure'
        };
        expect(legacyAgentJournalTurnStatusBody(failed, 'legacy:claude:s:turn-lifecycle%3At1')).toEqual({
            kind: 'status',
            text: 'Claude turn completed',
            turnLifecycle: failed
        });
    });
});
describe('journalRowSchemaVersion', ()=>{
    it('stamps only rows that carry a turn item with the current version', ()=>{
        expect(AGENT_SESSION_JOURNAL_SCHEMA_VERSION).toBe(3);
        expect(journalRowSchemaVersion([
            agentJournalTurnBody(turn)
        ])).toBe(3);
        expect(journalRowSchemaVersion([
            {
                kind: 'message'
            },
            {
                kind: 'status'
            }
        ])).toBe(2);
        expect(journalRowSchemaVersion([])).toBe(2);
    });
});
