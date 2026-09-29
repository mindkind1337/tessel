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
import { renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { clearNativeChatModelEnrichmentForTests, ensureNativeChatModelEnrichment, readNativeChatEnrichedModels } from "../native-chat-session-option-enrichment.js";
const mocks = vi.hoisted(()=>({
        callRuntimeRpc: vi.fn(),
        createNativeChatPtySessionOptions: vi.fn(),
        discoverNativeChatCatalogModels: vi.fn()
    }));
vi.mock('../../store', ()=>({
        useAppStore: (selector)=>selector({
                agentStatusByPaneKey: {}
            })
    }));
vi.mock('@/runtime/runtime-rpc-client', ()=>({
        callRuntimeRpc: mocks.callRuntimeRpc
    }));
vi.mock('./native-chat-pty-session-options', ()=>({
        createNativeChatPtySessionOptions: mocks.createNativeChatPtySessionOptions
    }));
vi.mock('./native-chat-session-option-discovery', ()=>({
        resolveNativeChatModelDiscoveryContext: ()=>({
                hostKey: 'local',
                runtime: {}
            }),
        discoverNativeChatCatalogModels: mocks.discoverNativeChatCatalogModels
    }));
const { retirePersistedModelMissingFromDiscovery, useNativeChatSessionOptions } = await import('./use-native-chat-session-options');
const models = (...ids)=>ids.map((id)=>({
            id,
            label: id,
            options: []
        }));
const LOCAL_TARGET = {
    kind: 'local'
};
describe('retirePersistedModelMissingFromDiscovery', ()=>{
    beforeEach(()=>{
        mocks.callRuntimeRpc.mockReset().mockResolvedValue({
            ok: true
        });
    });
    it('clears a persisted id the authoritative probe no longer lists', async ()=>{
        await retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5'));
        expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL_TARGET, 'settings.mutateNativeChatSessionOptions', {
            type: 'clear-model-if-missing',
            agent: 'grok',
            availableModelIds: [
                'grok-4.5'
            ]
        });
    });
    it('lets the host keep a concurrently selected model from the available list', async ()=>{
        await retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5', 'grok-build'));
        expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL_TARGET, 'settings.mutateNativeChatSessionOptions', {
            type: 'clear-model-if-missing',
            agent: 'grok',
            availableModelIds: [
                'grok-4.5',
                'grok-build'
            ]
        });
    });
    it('treats an empty list as a failed probe, not an empty account', async ()=>{
        await retirePersistedModelMissingFromDiscovery('grok', []);
        expect(mocks.callRuntimeRpc).not.toHaveBeenCalled();
    });
    it('leaves additive agents alone, whose lists extend the seed rather than replace it', async ()=>{
        await retirePersistedModelMissingFromDiscovery('cursor', models('auto'));
        expect(mocks.callRuntimeRpc).not.toHaveBeenCalled();
    });
    it('does not depend on a client-local settings snapshot', async ()=>{
        await expect(retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5'))).resolves.toBeUndefined();
        expect(mocks.callRuntimeRpc).toHaveBeenCalledOnce();
    });
    it('swallows a failed best-effort retirement write', async ()=>{
        mocks.callRuntimeRpc.mockRejectedValue(new Error('runtime offline'));
        await expect(retirePersistedModelMissingFromDiscovery('grok', models('grok-4.5'))).resolves.toBeUndefined();
    });
});
describe('useNativeChatSessionOptions retirement on mount', ()=>{
    const mountPane = ()=>{
        renderHook(()=>useNativeChatSessionOptions({
                agent: 'grok',
                terminalTabId: 'tab-1',
                targetPtyId: 'pty-1',
                dispatchCommand: ()=>undefined
            }));
    };
    beforeEach(()=>{
        clearNativeChatModelEnrichmentForTests();
        mocks.callRuntimeRpc.mockReset().mockResolvedValue({
            ok: true
        });
        mocks.discoverNativeChatCatalogModels.mockReset().mockResolvedValue(null);
        const emptySnapshot = [];
        mocks.createNativeChatPtySessionOptions.mockReset().mockImplementation(()=>({
                subscribe: ()=>()=>{},
                getSnapshot: ()=>emptySnapshot,
                recordOutgoingCommand: ()=>{},
                reportSessionOptions: ()=>{},
                replaceModels: ()=>{}
            }));
    });
    it('retires a persisted id against models the probe already cached', async ()=>{
        ensureNativeChatModelEnrichment({
            agent: 'grok',
            hostKey: 'local',
            discover: async ()=>models('grok-4.5')
        });
        await vi.waitFor(()=>expect(readNativeChatEnrichedModels('grok', 'local')).not.toBeNull());
        mountPane();
        await vi.waitFor(()=>expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL_TARGET, 'settings.mutateNativeChatSessionOptions', expect.objectContaining({
                type: 'clear-model-if-missing',
                agent: 'grok'
            })));
    });
    it('leaves the persisted id alone while the probe is still in flight', async ()=>{
        mocks.discoverNativeChatCatalogModels.mockReturnValue(new Promise(()=>{}));
        mountPane();
        await Promise.resolve();
        expect(mocks.callRuntimeRpc).not.toHaveBeenCalled();
    });
    it('keeps PTY picks in the client settings record used by paired launches', async ()=>{
        mountPane();
        const persistSelection = mocks.createNativeChatPtySessionOptions.mock.calls[0]?.[0]?.persistSelection;
        await persistSelection?.({
            modelId: 'grok-4.5',
            optionId: 'effort',
            value: 'high',
            adoptModelAsLaunchDefault: true
        });
        expect(mocks.callRuntimeRpc).toHaveBeenCalledWith(LOCAL_TARGET, 'settings.mutateNativeChatSessionOptions', expect.objectContaining({
            type: 'apply-picks',
            agent: 'grok'
        }));
    });
});
