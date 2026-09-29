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
import { clearNativeChatSessionOptionCacheForTests } from "../native-chat-session-option-cache.js";
import { createNativeChatPtySessionOptions } from "../native-chat-pty-session-options.js";
import { normalizeAgentStatusPayload, pickParsedAgentStatusPayload } from "../shared/agent-status-types.js";
describe('OMP model command capability', ()=>{
    beforeEach(()=>clearNativeChatSessionOptionCacheForTests());
    it.each([
        undefined,
        false,
        true
    ])('only enables a live command after host advertisement: %s', async (canSwitchOmpModel)=>{
        const dispatchCommand = vi.fn();
        const surface = createNativeChatPtySessionOptions({
            agent: 'omp',
            scopeKey: 'omp-model-test',
            mode: 'live',
            canSwitchOmpModel,
            initialModels: [
                {
                    id: 'openai/a',
                    label: 'A',
                    options: []
                },
                {
                    id: 'openai/b',
                    label: 'B',
                    options: []
                }
            ],
            reportedValues: {
                model: 'openai/a'
            },
            dispatchCommand
        });
        if (!surface) {
            throw new Error('expected OMP surface');
        }
        expect(surface.getSnapshot()[0].settable).toBe(canSwitchOmpModel === true);
        if (canSwitchOmpModel) {
            await surface.setOption('model', 'openai/b');
            expect(dispatchCommand).toHaveBeenCalledWith('/orca-model openai/b');
        } else {
            await expect(surface.setOption('model', 'openai/b')).rejects.toThrow();
            expect(dispatchCommand).not.toHaveBeenCalled();
        }
    });
    it('preserves only the recognized capability through normalization and remote projection', ()=>{
        for (const command of [
            'orca-model',
            'arbitrary-command',
            undefined
        ]){
            const payload = normalizeAgentStatusPayload({
                state: 'done',
                agentType: 'omp',
                modelSwitchCommand: command
            });
            if (!payload) {
                throw new Error('expected status');
            }
            expect(pickParsedAgentStatusPayload(payload).modelSwitchCommand).toBe(command === 'orca-model' ? command : undefined);
        }
    });
});
