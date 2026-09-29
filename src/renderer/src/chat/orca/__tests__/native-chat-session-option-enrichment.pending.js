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
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverNativeChatCatalogModels, resolveNativeChatModelDiscoveryHostKey } from "../native-chat-session-option-discovery.js";
import { clearNativeChatModelEnrichmentForTests, ensureNativeChatModelEnrichment, getNativeChatModelEnrichmentEntryCountForTests, NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES, readNativeChatEnrichedModels, resolveNativeChatLaunchSessionOptions, subscribeNativeChatEnrichedModels } from "../native-chat-session-option-enrichment.js";
const mocks = vi.hoisted(()=>({
        discoverRuntimeCommitMessageModels: vi.fn(),
        callStructuredAgentSession: vi.fn()
    }));
vi.mock('@/runtime/runtime-git-client', ()=>({
        discoverRuntimeCommitMessageModels: mocks.discoverRuntimeCommitMessageModels,
        getRuntimeGitScope: vi.fn()
    }));
vi.mock('@/runtime/structured-agent-session-client', ()=>({
        callStructuredAgentSession: mocks.callStructuredAgentSession
    }));
describe('native chat session option enrichment', ()=>{
    beforeEach(()=>{
        clearNativeChatModelEnrichmentForTests();
        mocks.discoverRuntimeCommitMessageModels.mockReset();
        mocks.callStructuredAgentSession.mockReset().mockResolvedValue({
            origin: 'live-session',
            models: [
                {
                    id: 'gpt-host',
                    label: 'GPT Host',
                    isDefault: true,
                    efforts: []
                }
            ],
            fetchedAt: 1
        });
    });
    it('reads the host catalog only for a pane on this machine', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'probe',
            models: [
                {
                    id: 'gpt-cli',
                    label: 'GPT CLI'
                }
            ]
        });
        const context = {
            settings: {},
            worktreeId: 'repo::/worktree',
            worktreePath: '/worktree'
        };
        const local = await discoverNativeChatCatalogModels('codex', context, 'local');
        expect(local?.map(({ id })=>id)).toEqual([
            'gpt-host'
        ]);
        expect(mocks.discoverRuntimeCommitMessageModels).not.toHaveBeenCalled();
        mocks.callStructuredAgentSession.mockClear();
        const paired = await discoverNativeChatCatalogModels('codex', context, 'runtime:env-1');
        expect(mocks.callStructuredAgentSession).not.toHaveBeenCalled();
        expect(paired?.map(({ id })=>id)).toContain('gpt-cli');
    });
    it('bounds settled host enrichment entries', async ()=>{
        for(let index = 0; index < NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES + 4; index += 1){
            ensureNativeChatModelEnrichment({
                agent: 'cursor',
                hostKey: `ssh:${index}`,
                discover: async ()=>[]
            });
        }
        await Promise.resolve();
        await Promise.resolve();
        expect(getNativeChatModelEnrichmentEntryCountForTests()).toBe(NATIVE_CHAT_MODEL_ENRICHMENT_MAX_ENTRIES);
    });
    it('keeps reads synchronous while one host-scoped probe is in flight', async ()=>{
        let resolveDiscovery;
        const discover = vi.fn(()=>new Promise((resolve)=>{
                resolveDiscovery = resolve;
            }));
        const listener = vi.fn();
        subscribeNativeChatEnrichedModels('cursor', 'ssh:one', listener);
        ensureNativeChatModelEnrichment({
            agent: 'cursor',
            hostKey: 'ssh:one',
            discover
        });
        ensureNativeChatModelEnrichment({
            agent: 'cursor',
            hostKey: 'ssh:one',
            discover
        });
        expect(readNativeChatEnrichedModels('cursor', 'ssh:one')).toBeNull();
        expect(discover).toHaveBeenCalledOnce();
        resolveDiscovery?.([
            {
                id: 'gpt-5.3-codex',
                label: 'GPT 5.3 live',
                options: []
            },
            {
                id: 'account-model',
                label: 'Account model',
                options: []
            }
        ]);
        await vi.waitFor(()=>expect(listener).toHaveBeenCalledOnce());
        const models = readNativeChatEnrichedModels('cursor', 'ssh:one');
        expect(models.find((model)=>model.id === 'gpt-5.3-codex')).toMatchObject({
            label: 'GPT 5.3 live',
            options: expect.arrayContaining([
                expect.objectContaining({
                    id: 'effort'
                })
            ])
        });
        expect(models.at(-1)).toMatchObject({
            id: 'account-model'
        });
        expect(readNativeChatEnrichedModels('cursor', 'ssh:two')).toBeNull();
    });
    it('falls back permanently to the seed after a failed once-per-host probe', async ()=>{
        const discover = vi.fn().mockRejectedValue(new Error('offline'));
        ensureNativeChatModelEnrichment({
            agent: 'cursor',
            hostKey: 'local',
            discover
        });
        await vi.waitFor(()=>expect(discover).toHaveBeenCalledOnce());
        await Promise.resolve();
        ensureNativeChatModelEnrichment({
            agent: 'cursor',
            hostKey: 'local',
            discover
        });
        expect(discover).toHaveBeenCalledOnce();
        expect(readNativeChatEnrichedModels('cursor', 'local')).toBeNull();
    });
    it('does not probe agents whose catalogs have no discovery command', ()=>{
        const discover = vi.fn();
        ensureNativeChatModelEnrichment({
            agent: 'gemini',
            hostKey: 'local',
            discover
        });
        expect(discover).not.toHaveBeenCalled();
    });
    it('keeps WSL discovery separate from the Windows host and other distros', ()=>{
        expect(resolveNativeChatModelDiscoveryHostKey({}, null, '\\\\wsl.localhost\\Ubuntu\\home\\orca', null)).toBe('wsl:Ubuntu');
        expect(resolveNativeChatModelDiscoveryHostKey({}, null, '\\\\wsl.localhost\\Debian\\home\\orca', null)).toBe('wsl:Debian');
        expect(resolveNativeChatModelDiscoveryHostKey({}, null, 'C:\\repo', null)).toBe('local');
    });
    it('uses only discovered Claude rows and capabilities per host', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'probe',
            models: [
                {
                    id: 'opus[1m]',
                    label: 'Opus (1M context)',
                    description: 'Opus 5 with 1M context',
                    thinkingLevels: [
                        {
                            id: 'low',
                            label: 'Low'
                        },
                        {
                            id: 'high',
                            label: 'High'
                        }
                    ],
                    defaultThinkingLevel: 'low',
                    supportsFastMode: true
                },
                {
                    id: 'sonnet',
                    label: 'Sonnet',
                    thinkingLevels: [
                        {
                            id: 'medium',
                            label: 'Medium'
                        }
                    ]
                }
            ]
        });
        const discover = vi.fn(()=>discoverNativeChatCatalogModels('claude', {
                settings: {},
                worktreeId: 'repo::/worktree',
                worktreePath: '/worktree'
            }));
        const listener = vi.fn();
        subscribeNativeChatEnrichedModels('claude', 'ssh:host', listener);
        ensureNativeChatModelEnrichment({
            agent: 'claude',
            hostKey: 'ssh:host',
            discover
        });
        await vi.waitFor(()=>expect(listener).toHaveBeenCalledOnce());
        const models = readNativeChatEnrichedModels('claude', 'ssh:host');
        expect(models.map(({ id })=>id)).toEqual([
            'opus[1m]',
            'sonnet'
        ]);
        const sonnetEffort = models.find(({ id })=>id === 'sonnet')?.options[0];
        expect(sonnetEffort?.kind).toMatchObject({
            type: 'select',
            choices: [
                {
                    value: 'medium',
                    label: 'Medium'
                }
            ]
        });
        expect(models.find(({ id })=>id === 'opus[1m]')).toMatchObject({
            id: 'opus[1m]',
            description: 'Opus 5 with 1M context',
            options: [
                expect.objectContaining({
                    id: 'effort',
                    kind: expect.objectContaining({
                        choices: [
                            {
                                value: 'low',
                                label: 'Low'
                            },
                            {
                                value: 'high',
                                label: 'High'
                            }
                        ]
                    })
                }),
                expect.objectContaining({
                    id: 'fastMode'
                })
            ]
        });
        expect(readNativeChatEnrichedModels('claude', 'local')).toBeNull();
    });
    it('carries grok’s probed default through discovery to the published rows', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'probe',
            models: [
                {
                    id: 'grok-build',
                    label: 'Grok Build'
                },
                {
                    id: 'grok-5',
                    label: 'Grok 5',
                    isDefault: true
                }
            ]
        });
        const discover = vi.fn(()=>discoverNativeChatCatalogModels('grok', {
                settings: {},
                worktreeId: 'repo::/worktree',
                worktreePath: '/worktree'
            }));
        const listener = vi.fn();
        subscribeNativeChatEnrichedModels('grok', 'ssh:host', listener);
        ensureNativeChatModelEnrichment({
            agent: 'grok',
            hostKey: 'ssh:host',
            discover
        });
        await vi.waitFor(()=>expect(listener).toHaveBeenCalledOnce());
        const models = readNativeChatEnrichedModels('grok', 'ssh:host');
        expect(models.map(({ id, isDefault })=>[
                id,
                isDefault
            ])).toEqual([
            [
                'grok-build',
                undefined
            ],
            [
                'grok-5',
                true
            ]
        ]);
        expect(models.map((model)=>model.options.map(({ id })=>id))).toEqual([
            [
                'effort'
            ],
            [
                'effort'
            ]
        ]);
    });
    it('publishes no default when an older host omits the flag entirely', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'probe',
            models: [
                {
                    id: 'grok-4.5',
                    label: 'Grok 4.5'
                }
            ]
        });
        const discover = vi.fn(()=>discoverNativeChatCatalogModels('grok', {
                settings: {},
                worktreeId: 'repo::/worktree',
                worktreePath: '/worktree'
            }));
        const listener = vi.fn();
        subscribeNativeChatEnrichedModels('grok', 'ssh:legacy', listener);
        ensureNativeChatModelEnrichment({
            agent: 'grok',
            hostKey: 'ssh:legacy',
            discover
        });
        await vi.waitFor(()=>expect(listener).toHaveBeenCalledOnce());
        const published = readNativeChatEnrichedModels('grok', 'ssh:legacy');
        expect(published.map(({ id })=>id)).toEqual([
            'grok-4.5'
        ]);
        expect(published[0].isDefault).toBeUndefined();
    });
    it('rejects a spec fallback for grok too, not just claude', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'spec',
            models: [
                {
                    id: 'grok-4.5',
                    label: 'Grok 4.5'
                }
            ]
        });
        await expect(discoverNativeChatCatalogModels('grok', {
            settings: {},
            worktreeId: 'repo::/worktree',
            worktreePath: '/worktree'
        })).resolves.toBeNull();
    });
    it('still lets a spec fallback through for an additive agent', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'spec',
            models: [
                {
                    id: 'auto',
                    label: 'Auto'
                }
            ]
        });
        await expect(discoverNativeChatCatalogModels('cursor', {
            settings: {},
            worktreeId: 'repo::/worktree',
            worktreePath: '/worktree'
        })).resolves.toEqual([
            {
                id: 'auto',
                label: 'Auto',
                options: []
            }
        ]);
    });
    it('uses the authoritative merge for grok and the additive one for cursor', async ()=>{
        const discoverGrok = vi.fn().mockResolvedValue([
            {
                id: 'grok-5',
                label: 'Grok 5',
                options: []
            }
        ]);
        const discoverCursor = vi.fn().mockResolvedValue([
            {
                id: 'extra',
                label: 'Extra',
                options: []
            }
        ]);
        ensureNativeChatModelEnrichment({
            agent: 'grok',
            hostKey: 'm',
            discover: discoverGrok
        });
        ensureNativeChatModelEnrichment({
            agent: 'cursor',
            hostKey: 'm',
            discover: discoverCursor
        });
        await vi.waitFor(()=>{
            expect(readNativeChatEnrichedModels('grok', 'm')).not.toBeNull();
            expect(readNativeChatEnrichedModels('cursor', 'm')).not.toBeNull();
        });
        expect(readNativeChatEnrichedModels('grok', 'm').map(({ id })=>id)).toEqual([
            'grok-5'
        ]);
        expect(readNativeChatEnrichedModels('cursor', 'm').map(({ id })=>id)).toContain('auto');
    });
    it('drops a persisted grok launch model missing from every settled probe', async ()=>{
        const persisted = {
            grok: {
                model: 'grok-4.5',
                valuesByModel: {
                    'grok-4.5': {
                        effort: 'low'
                    }
                }
            }
        };
        expect(resolveNativeChatLaunchSessionOptions(persisted, 'grok')).toMatchObject({
            model: 'grok-4.5',
            effort: 'low'
        });
        const discover = vi.fn().mockResolvedValue([
            {
                id: 'grok-5',
                label: 'Grok 5',
                options: []
            }
        ]);
        ensureNativeChatModelEnrichment({
            agent: 'grok',
            hostKey: 'local',
            discover
        });
        await vi.waitFor(()=>expect(readNativeChatEnrichedModels('grok', 'local')).not.toBeNull());
        expect(resolveNativeChatLaunchSessionOptions(persisted, 'grok')).toBeUndefined();
        expect(resolveNativeChatLaunchSessionOptions({
            grok: {
                model: 'grok-5'
            }
        }, 'grok')).toEqual({
            model: 'grok-5'
        });
        expect(resolveNativeChatLaunchSessionOptions({
            claude: {
                model: 'retired'
            }
        }, 'claude')).toEqual({
            model: 'retired'
        });
    });
    it('does not advertise the Claude spec fallback when probing is unavailable', async ()=>{
        mocks.discoverRuntimeCommitMessageModels.mockResolvedValue({
            success: true,
            catalogOrigin: 'spec',
            models: [
                {
                    id: 'sonnet',
                    label: 'Sonnet'
                }
            ]
        });
        await expect(discoverNativeChatCatalogModels('claude', {
            settings: {},
            worktreeId: 'repo::/worktree',
            worktreePath: '/worktree'
        })).resolves.toBeNull();
    });
});
