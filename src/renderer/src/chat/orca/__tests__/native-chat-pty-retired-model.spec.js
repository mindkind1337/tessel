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
import { mergeDiscoveredAuthoritativeModels } from "../shared/agent-session-option-catalog.js";
import { GROK_SESSION_OPTION_CATALOG } from "../shared/agent-session-option-catalog-grok.js";
import { updateNativeChatSessionOptionDefaults } from "../shared/native-chat-session-option-defaults.js";
import { clearNativeChatSessionOptionCacheForTests, readNativeChatSessionOptionCache, seedNativeChatAppliedSessionOptions } from "../native-chat-session-option-cache.js";
import { createNativeChatPtySessionOptions } from "../native-chat-pty-session-options.js";
const discoveredGrok5 = ()=>mergeDiscoveredAuthoritativeModels(GROK_SESSION_OPTION_CATALOG.models, [
        {
            id: 'grok-5',
            label: 'Grok 5',
            isDefault: true,
            options: []
        }
    ]);
function createGrokSurface(args) {
    let persisted = {};
    const surface = createNativeChatPtySessionOptions({
        agent: 'grok',
        scopeKey: 'pty-1',
        mode: 'live',
        dispatchCommand: vi.fn(),
        persistSelection: ({ modelId, optionId, value, adoptModelAsLaunchDefault })=>{
            persisted = updateNativeChatSessionOptionDefaults({
                persisted,
                agent: 'grok',
                modelId,
                optionId,
                value,
                adoptModelAsLaunchDefault
            });
        },
        ...args
    });
    return {
        surface,
        persisted: ()=>persisted
    };
}
describe('retired grok model untracking', ()=>{
    beforeEach(()=>clearNativeChatSessionOptionCacheForTests());
    it('untracks a picked model an authoritative discovery dropped', async ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'grok', {
            model: 'grok-4.5'
        });
        const { surface, persisted } = createGrokSurface();
        surface.replaceModels(discoveredGrok5());
        expect(surface.getSnapshot()[0].kind).toMatchObject({
            currentValue: 'grok-5',
            choices: [
                expect.objectContaining({
                    value: 'grok-5'
                })
            ]
        });
        expect(readNativeChatSessionOptionCache('pty-1')?.model).toBeUndefined();
        await surface.setOption('effort', 'low');
        expect(persisted().grok?.model).toBe('grok-5');
    });
    it('untracks a cached retired model at surface creation', ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'grok', {
            model: 'grok-4.5'
        });
        const { surface } = createGrokSurface({
            initialModels: discoveredGrok5()
        });
        expect(surface.getSnapshot()[0].kind).toMatchObject({
            currentValue: 'grok-5',
            choices: [
                expect.objectContaining({
                    value: 'grok-5'
                })
            ]
        });
        expect(readNativeChatSessionOptionCache('pty-1')?.model).toBeUndefined();
    });
    it('never persists a typed model the authoritative list lacks', ()=>{
        const { surface, persisted } = createGrokSurface({
            initialModels: discoveredGrok5()
        });
        surface.recordOutgoingCommand('/model grok-4.5');
        expect(persisted().grok?.model).toBeUndefined();
        surface.recordOutgoingCommand('/model grok-5');
        expect(persisted().grok?.model).toBe('grok-5');
    });
});
