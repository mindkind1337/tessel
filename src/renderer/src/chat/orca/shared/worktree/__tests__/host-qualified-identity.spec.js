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
import { toRuntimeExecutionHostId, toSshExecutionHostId } from "../../execution-host.js";
import { composeWorktreeHostIdentity, getExecutionHostIdFromWorktreeHostIdentity, getWorktreeHostIdentity, getWorktreeIdFromHostIdentity } from "../host-qualified-identity.js";
const WORKTREE_ID = 'repo-1::/work/orca';
describe('worktree host identity', ()=>{
    it('separates two hosts that publish the same id', ()=>{
        expect(getWorktreeHostIdentity({
            id: WORKTREE_ID,
            hostId: 'local'
        })).not.toBe(getWorktreeHostIdentity({
            id: WORKTREE_ID,
            hostId: 'ssh:build-box'
        }));
    });
    it('gives an unqualified row its own bucket', ()=>{
        expect(getWorktreeHostIdentity({
            id: WORKTREE_ID,
            hostId: undefined
        })).not.toBe(getWorktreeHostIdentity({
            id: WORKTREE_ID,
            hostId: 'local'
        }));
    });
    it('round-trips the id back out for every host shape', ()=>{
        const hostIds = [
            undefined,
            'local',
            toSshExecutionHostId('build-box'),
            toSshExecutionHostId('deploy@10.0.0.4:2222'),
            toRuntimeExecutionHostId('03ef704c-b180-4b10-998d-e28fbd5de9a3')
        ];
        for (const hostId of hostIds){
            expect(getWorktreeIdFromHostIdentity(composeWorktreeHostIdentity(hostId, WORKTREE_ID))).toBe(WORKTREE_ID);
        }
    });
    it('round-trips a workspace id that itself contains the separator', ()=>{
        const awkwardId = 'repo-1::/work/a|b/orca';
        expect(getWorktreeIdFromHostIdentity(composeWorktreeHostIdentity(toSshExecutionHostId('build-box'), awkwardId))).toBe(awkwardId);
    });
    it('keeps a host id free of the separator by construction', ()=>{
        expect(toSshExecutionHostId('we|rd')).not.toContain('|');
        expect(toRuntimeExecutionHostId('we|rd')).not.toContain('|');
    });
    it('rejects identities without a host separator', ()=>{
        expect(getExecutionHostIdFromWorktreeHostIdentity('ssh:build-box')).toBeUndefined();
    });
    it('leaves an unqualified identity without a host', ()=>{
        expect(getExecutionHostIdFromWorktreeHostIdentity(composeWorktreeHostIdentity(undefined, WORKTREE_ID))).toBeUndefined();
    });
    it('recovers the host from a qualified identity', ()=>{
        expect(getExecutionHostIdFromWorktreeHostIdentity(composeWorktreeHostIdentity('local', WORKTREE_ID))).toBe('local');
        expect(getExecutionHostIdFromWorktreeHostIdentity(composeWorktreeHostIdentity(toSshExecutionHostId('build-box'), WORKTREE_ID))).toBe(toSshExecutionHostId('build-box'));
    });
});
