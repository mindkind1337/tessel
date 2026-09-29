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
import { leaseCarriesLegacyHandoffValues, normalizeLegacyHandoffLease, normalizeLegacyHandoffRecord, terminalOwnerRefusalMessage } from "../agent-session-legacy-handoff-lease.js";
import { agentSessionLeaseFixture, agentSessionRecordFixture } from "../agent-session-record.test-fixture.js";
const CLAIMS = [
    'reserved',
    'live',
    'conflicted',
    'released'
];
const STAGES = [
    null,
    'new-owner-proving',
    'recovering'
];
function persisted(overrides) {
    return {
        ...agentSessionLeaseFixture(),
        ...overrides
    };
}
describe('normalizing a lease the removed terminal handoff wrote', ()=>{
    it('leaves every lease this build writes as it is', ()=>{
        for (const claimStatus of CLAIMS){
            for (const handoffStage of STAGES){
                for (const ownerProcess of [
                    agentSessionLeaseFixture().ownerProcess,
                    null
                ]){
                    const lease = agentSessionLeaseFixture({
                        claimStatus,
                        handoffStage,
                        ownerProcess
                    });
                    expect(normalizeLegacyHandoffLease(lease)).toEqual(lease);
                    expect(leaseCarriesLegacyHandoffValues(lease)).toBe(false);
                }
            }
        }
    });
    it.each([
        'preparing',
        'old-owner-stopped',
        'manual-recovery'
    ])('maps the %s stage to recovering and keeps its operation id', (handoffStage)=>{
        const lease = persisted({
            handoffStage,
            handoffOperationId: 'op-handoff'
        });
        expect(normalizeLegacyHandoffLease(lease)).toEqual({
            ...lease,
            handoffStage: 'recovering'
        });
        expect(leaseCarriesLegacyHandoffValues(lease)).toBe(true);
    });
    it.each(CLAIMS)('turns a recorded terminal owner (%s) into a conflicted native claim', (claim)=>{
        const lease = persisted({
            runtimeKind: 'tui',
            claimStatus: claim
        });
        expect(normalizeLegacyHandoffLease(lease)).toEqual({
            ...lease,
            runtimeKind: 'native',
            claimStatus: 'conflicted'
        });
    });
    it.each(CLAIMS)('changes only the kind of a terminal lease naming no process (%s)', (claim)=>{
        const lease = persisted({
            runtimeKind: 'tui',
            claimStatus: claim,
            ownerProcess: null
        });
        expect(normalizeLegacyHandoffLease(lease)).toEqual({
            ...lease,
            runtimeKind: 'native'
        });
        expect(leaseCarriesLegacyHandoffValues(lease)).toBe(true);
    });
    it('maps a terminal owner mid return trip on both fields', ()=>{
        const lease = persisted({
            runtimeKind: 'tui',
            handoffStage: 'old-owner-stopped'
        });
        expect(normalizeLegacyHandoffLease(lease)).toMatchObject({
            runtimeKind: 'native',
            handoffStage: 'recovering',
            claimStatus: 'conflicted'
        });
    });
    it('reports whether a record needed normalizing', ()=>{
        const record = agentSessionRecordFixture();
        expect(normalizeLegacyHandoffRecord(record)).toEqual({
            record,
            normalized: false
        });
        const legacy = {
            ...record,
            lease: persisted({
                runtimeKind: 'tui'
            })
        };
        expect(normalizeLegacyHandoffRecord(legacy)).toEqual({
            record: {
                ...record,
                lease: {
                    ...record.lease,
                    claimStatus: 'conflicted'
                }
            },
            normalized: true
        });
    });
});
describe('the refusal for a chat a terminal agent holds', ()=>{
    const owner = {
        hostId: 'local',
        pid: 4242,
        spawnToken: 'token'
    };
    it('names the process only when its start time can tell it from a reused pid', ()=>{
        const verifiable = agentSessionLeaseFixture({
            claimStatus: 'conflicted',
            ownerProcess: {
                ...owner,
                processStartTimeMs: 1_000
            }
        });
        const reusable = agentSessionLeaseFixture({
            claimStatus: 'conflicted',
            ownerProcess: {
                ...owner,
                processStartTimeMs: null
            }
        });
        expect(terminalOwnerRefusalMessage(verifiable)).toBe('This chat is still open in a terminal agent (process 4242). Quit that agent to continue the chat here.');
        expect(terminalOwnerRefusalMessage(reusable)).toBe('This chat is still open in a terminal agent. Quit that agent to continue the chat here.');
    });
});
