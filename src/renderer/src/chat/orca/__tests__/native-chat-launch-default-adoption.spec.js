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
import { clearNativeChatSessionOptionCacheForTests, seedNativeChatAppliedSessionOptions } from "../native-chat-session-option-cache.js";
import { createNativeChatPtySessionOptions } from "../native-chat-pty-session-options.js";
import { resolveNativeChatSessionOptionDefaults, updateNativeChatSessionOptionDefaults } from "../shared/native-chat-session-option-defaults.js";
describe('native chat launch-default adoption', ()=>{
    beforeEach(()=>clearNativeChatSessionOptionCacheForTests());
    const HOST_CLAUDE_MODELS = [
        {
            id: 'opus[1m]',
            label: 'Opus (1M context)',
            options: []
        },
        {
            id: 'sonnet',
            label: 'Sonnet',
            options: []
        }
    ];
    const claudeLaunchDefaults = ()=>{
        let persisted = {};
        return {
            read: ()=>persisted,
            persistSelection: (args)=>{
                persisted = updateNativeChatSessionOptionDefaults({
                    persisted,
                    agent: 'claude',
                    ...args
                });
            }
        };
    };
    it('does not adopt a launch-flag model no list carries as the persisted launch default', async ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
            model: 'claude-opus-5'
        });
        const defaults = claudeLaunchDefaults();
        const surface = createNativeChatPtySessionOptions({
            agent: 'claude',
            scopeKey: 'pty-1',
            initialModels: HOST_CLAUDE_MODELS,
            mode: 'live',
            dispatchCommand: vi.fn().mockResolvedValue({
                outcome: 'applied'
            }),
            persistSelection: defaults.persistSelection
        });
        await surface.setOption('model', 'claude-opus-5');
        expect(defaults.read().claude?.model).toBeUndefined();
        expect(resolveNativeChatSessionOptionDefaults(defaults.read(), 'claude')).toBeUndefined();
    });
    it('does not adopt an unlisted launch-flag model before discovery either', async ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
            model: 'claude-opus-5'
        });
        const defaults = claudeLaunchDefaults();
        const surface = createNativeChatPtySessionOptions({
            agent: 'claude',
            scopeKey: 'pty-1',
            mode: 'live',
            dispatchCommand: vi.fn().mockResolvedValue({
                outcome: 'applied'
            }),
            persistSelection: defaults.persistSelection
        });
        await surface.setOption('model', 'claude-opus-5');
        expect(defaults.read().claude?.model).toBeUndefined();
    });
    it('still adopts a model only the host catalog lists', async ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
            model: 'sonnet'
        });
        const defaults = claudeLaunchDefaults();
        const surface = createNativeChatPtySessionOptions({
            agent: 'claude',
            scopeKey: 'pty-1',
            initialModels: HOST_CLAUDE_MODELS,
            mode: 'live',
            dispatchCommand: vi.fn().mockResolvedValue({
                outcome: 'applied'
            }),
            persistSelection: defaults.persistSelection
        });
        await surface.setOption('model', 'opus[1m]');
        expect(defaults.read().claude?.model).toBe('opus[1m]');
    });
    it('still adopts a seeded alias the host catalog has stopped listing', async ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
            model: 'opus',
            effort: 'xhigh'
        });
        const defaults = claudeLaunchDefaults();
        const surface = createNativeChatPtySessionOptions({
            agent: 'claude',
            scopeKey: 'pty-1',
            initialModels: HOST_CLAUDE_MODELS,
            mode: 'live',
            dispatchCommand: vi.fn(),
            persistSelection: defaults.persistSelection
        });
        await surface.setOption('effort', 'high');
        expect(resolveNativeChatSessionOptionDefaults(defaults.read(), 'claude')).toMatchObject({
            model: 'opus',
            effort: 'high'
        });
    });
    it('still adopts a tracked seed model before any discovery', async ()=>{
        seedNativeChatAppliedSessionOptions('pty-1', 'claude', {
            model: 'opus',
            effort: 'xhigh'
        });
        const defaults = claudeLaunchDefaults();
        const surface = createNativeChatPtySessionOptions({
            agent: 'claude',
            scopeKey: 'pty-1',
            mode: 'live',
            dispatchCommand: vi.fn(),
            persistSelection: defaults.persistSelection
        });
        await surface.setOption('effort', 'high');
        expect(defaults.read().claude?.model).toBe('opus');
    });
});
