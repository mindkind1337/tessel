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
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ALL_EXECUTION_HOSTS_SCOPE, LOCAL_EXECUTION_HOST_ID, getExecutionHostLabel, getLocalExecutionHostLabel, getRepoExecutionHostId, getRepoSshConnectionId, getSettingsFocusedExecutionHostId, getSshTargetIdForExecutionHost, getWorktreeExecutionHostId, normalizeExecutionHostOrder, normalizeExecutionHostScope, normalizeVisibleExecutionHostIds, parseExecutionHostId, requestedExecutionHostScope, toRuntimeExecutionHostId, toSshExecutionHostId } from "../execution-host.js";
describe('execution host identity', ()=>{
    afterEach(()=>{
        vi.unstubAllGlobals();
    });
    it('normalizes local, SSH, and runtime host ids', ()=>{
        expect(parseExecutionHostId('local')).toEqual({
            kind: 'local',
            id: 'local'
        });
        expect(parseExecutionHostId(toSshExecutionHostId('win vm'))).toEqual({
            kind: 'ssh',
            id: 'ssh:win%20vm',
            targetId: 'win vm'
        });
        expect(parseExecutionHostId(toRuntimeExecutionHostId('prod/server'))).toEqual({
            kind: 'runtime',
            id: 'runtime:prod%2Fserver',
            environmentId: 'prod/server'
        });
    });
    it('labels the local host by platform and by navigator detection', ()=>{
        expect(getLocalExecutionHostLabel('darwin')).toBe('Local Mac');
        expect(getLocalExecutionHostLabel('win32')).toBe('Local Windows');
        expect(getLocalExecutionHostLabel('linux')).toBe('Local Linux');
        expect(getLocalExecutionHostLabel('freebsd')).toBe('This computer');
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)'
        });
        expect(getLocalExecutionHostLabel()).toBe('Local Windows');
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (X11; Linux x86_64)'
        });
        expect(getLocalExecutionHostLabel()).toBe('Local Linux');
        vi.stubGlobal('navigator', {
            userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
        });
        expect(getLocalExecutionHostLabel()).toBe('Local Mac');
        vi.stubGlobal('navigator', {
            userAgent: 'totally-unknown-agent'
        });
        expect(getLocalExecutionHostLabel()).toBe(getLocalExecutionHostLabel(process.platform));
    });
    it('falls back invalid scopes to all hosts', ()=>{
        expect(normalizeExecutionHostScope(null)).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(normalizeExecutionHostScope('')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(normalizeExecutionHostScope('bogus')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(normalizeExecutionHostScope('ssh:')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(normalizeExecutionHostScope('all')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
    });
    it('defaults an omitted scope request to this host, not a fan-out', ()=>{
        expect(requestedExecutionHostScope(undefined)).toBe(LOCAL_EXECUTION_HOST_ID);
        expect(requestedExecutionHostScope(null)).toBe(LOCAL_EXECUTION_HOST_ID);
        expect(requestedExecutionHostScope('')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(requestedExecutionHostScope('bogus')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(requestedExecutionHostScope('all')).toBe(ALL_EXECUTION_HOSTS_SCOPE);
        expect(requestedExecutionHostScope('ssh:dev%20box')).toBe('ssh:dev%20box');
    });
    it('normalizes visible host id arrays', ()=>{
        expect(normalizeVisibleExecutionHostIds(null)).toBeNull();
        expect(normalizeVisibleExecutionHostIds([])).toBeNull();
        expect(normalizeVisibleExecutionHostIds([
            'local',
            'bogus',
            'ssh:win%20vm',
            'local'
        ])).toEqual([
            'local',
            'ssh:win%20vm'
        ]);
    });
    it('normalizes host order arrays', ()=>{
        expect(normalizeExecutionHostOrder(null)).toEqual([]);
        expect(normalizeExecutionHostOrder([])).toEqual([]);
        expect(normalizeExecutionHostOrder([
            'ssh:win%20vm',
            'bogus',
            'local',
            'ssh:win%20vm'
        ])).toEqual([
            'ssh:win%20vm',
            'local'
        ]);
    });
    it('derives repo ownership from SSH connection ids', ()=>{
        expect(getRepoExecutionHostId({
            connectionId: null
        })).toBe(LOCAL_EXECUTION_HOST_ID);
        expect(getRepoExecutionHostId({
            connectionId: 'ssh-target-1'
        })).toBe('ssh:ssh-target-1');
    });
    it('prefers explicit worktree ownership before repo and focused-host fallbacks', ()=>{
        expect(getWorktreeExecutionHostId({
            hostId: 'runtime:workspace-owner'
        }, {
            connectionId: 'repo-owner'
        }, 'runtime:focused-host')).toBe('runtime:workspace-owner');
        expect(getWorktreeExecutionHostId({}, {
            connectionId: 'repo-owner'
        }, 'runtime:focused-host')).toBe('ssh:repo-owner');
        expect(getWorktreeExecutionHostId({}, {}, 'runtime:focused-host')).toBe('runtime:focused-host');
    });
    it('distinguishes the SSH target holding a row from the connection this client may dial', ()=>{
        expect(getRepoSshConnectionId({
            connectionId: 'openclaw'
        })).toBe('openclaw');
        expect(getSshTargetIdForExecutionHost('ssh:openclaw')).toBe('openclaw');
        expect(getRepoSshConnectionId({
            executionHostId: 'ssh:m4air'
        })).toBe('m4air');
        expect(getRepoSshConnectionId({
            executionHostId: 'local',
            connectionId: 'openclaw'
        })).toBeNull();
        expect(getRepoSshConnectionId({
            executionHostId: 'runtime:env-a',
            connectionId: 'ssh-nested'
        })).toBe('ssh-nested');
        expect(getSshTargetIdForExecutionHost('runtime:env-a')).toBeNull();
        expect(getRepoSshConnectionId({
            executionHostId: 'runtime:env-a'
        })).toBeNull();
        expect(getRepoSshConnectionId({
            connectionId: 'runtime-ssh-vm-1'
        })).toBe('runtime-ssh-vm-1');
        expect(getRepoExecutionHostId({
            connectionId: 'runtime-ssh-vm-1'
        })).toBe('ssh:runtime-ssh-vm-1');
    });
    it('derives focused host compatibility from active runtime settings', ()=>{
        expect(getSettingsFocusedExecutionHostId(null)).toBe(LOCAL_EXECUTION_HOST_ID);
        expect(getSettingsFocusedExecutionHostId({
            activeRuntimeEnvironmentId: 'runtime-1'
        })).toBe('runtime:runtime-1');
    });
});
describe('execution host id delimiter invariant', ()=>{
    it('rejects an unencoded pipe so a crafted id cannot rebind a worktree identity alias', ()=>{
        expect(parseExecutionHostId('ssh:a|b')).toBeNull();
        expect(parseExecutionHostId('runtime:a|b')).toBeNull();
        expect(parseExecutionHostId(toSshExecutionHostId('a|b'))).toEqual({
            kind: 'ssh',
            id: 'ssh:a%7Cb',
            targetId: 'a|b'
        });
    });
    it('labels an id that names no host as one unknown host, not as every host', ()=>{
        for (const id of [
            'ssh:',
            'ssh:a|b',
            'ssh:%zz',
            'runtime:',
            'quantum:box'
        ]){
            expect(getExecutionHostLabel(id)).toBe('Unknown host');
        }
        expect(getExecutionHostLabel(null)).toBe('Unknown host');
        expect(getExecutionHostLabel(ALL_EXECUTION_HOSTS_SCOPE)).toBe('All hosts');
        expect(getExecutionHostLabel('ssh:box')).toBe('box');
        expect(getExecutionHostLabel('runtime:env-1')).toBe('env-1');
    });
});
