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
import { clearNativeChatSessionOptionModel, narrowStructuredLaunchSeedOptions, resolveNativeChatSessionOptionDefaults, resolveStructuredLaunchSeedOptions, updateNativeChatSessionOptionDefaults } from "../native-chat-session-option-defaults.js";
const persistedGrok = (model, valuesByModel = {})=>({
        grok: {
            ...model ? {
                model
            } : {},
            valuesByModel
        }
    });
describe('clearNativeChatSessionOptionModel', ()=>{
    it('drops the model a retired id would otherwise launch as -m', ()=>{
        const cleared = clearNativeChatSessionOptionModel(persistedGrok('grok-build', {
            'grok-build': {
                effort: 'low'
            }
        }), 'grok');
        expect(cleared.grok?.model).toBeUndefined();
        expect(resolveNativeChatSessionOptionDefaults(cleared, 'grok')).toBeUndefined();
    });
    it('keeps the per-model values so a reselect restores the old effort', ()=>{
        const cleared = clearNativeChatSessionOptionModel(persistedGrok('grok-build', {
            'grok-build': {
                effort: 'low'
            }
        }), 'grok');
        expect(cleared.grok?.valuesByModel).toEqual({
            'grok-build': {
                effort: 'low'
            }
        });
        const reselected = updateNativeChatSessionOptionDefaults({
            persisted: cleared,
            agent: 'grok',
            modelId: 'grok-build',
            optionId: 'model',
            value: 'grok-build'
        });
        expect(resolveNativeChatSessionOptionDefaults(reselected, 'grok')).toEqual({
            model: 'grok-build',
            effort: 'low'
        });
    });
    it('leaves every other agent untouched', ()=>{
        const cleared = clearNativeChatSessionOptionModel({
            ...persistedGrok('grok-build'),
            claude: {
                model: 'opus',
                valuesByModel: {}
            }
        }, 'grok');
        expect(cleared.claude).toEqual({
            model: 'opus',
            valuesByModel: {}
        });
    });
    it('is a no-op when nothing is persisted for the agent', ()=>{
        expect(clearNativeChatSessionOptionModel(undefined, 'grok')).toEqual({});
        expect(clearNativeChatSessionOptionModel({}, 'grok')).toEqual({});
        const untouched = persistedGrok(undefined, {
            'grok-4.5': {
                effort: 'high'
            }
        });
        expect(clearNativeChatSessionOptionModel(untouched, 'grok')).toEqual(untouched);
    });
});
describe('resolveNativeChatSessionOptionDefaults', ()=>{
    it('emits nothing until a model is explicitly picked, preserving the CLI default', ()=>{
        expect(resolveNativeChatSessionOptionDefaults(undefined, 'grok')).toBeUndefined();
        expect(resolveNativeChatSessionOptionDefaults(persistedGrok(undefined), 'grok')).toBeUndefined();
        expect(resolveNativeChatSessionOptionDefaults(persistedGrok('   '), 'grok')).toBeUndefined();
    });
    it('returns a stale id verbatim, which is why retirement happens upstream', ()=>{
        expect(resolveNativeChatSessionOptionDefaults(persistedGrok('grok-build'), 'grok')).toEqual({
            model: 'grok-build'
        });
    });
});
describe('resolveStructuredLaunchSeedOptions', ()=>{
    const persistedCodex = (valuesByModel)=>({
            codex: {
                model: 'gpt-5.6-sol',
                valuesByModel
            }
        });
    it('seeds the saved model and effort a structured create must apply', ()=>{
        expect(resolveStructuredLaunchSeedOptions(persistedCodex({
            'gpt-5.6-sol': {
                effort: 'medium'
            }
        }), 'codex')).toEqual({
            model: 'gpt-5.6-sol',
            effort: 'medium'
        });
    });
    it('encodes Fast mode while dropping ids the providers only accept mid-session', ()=>{
        expect(resolveStructuredLaunchSeedOptions(persistedCodex({
            'gpt-5.6-sol': {
                effort: 'high',
                fastMode: true,
                personality: 'concise'
            }
        }), 'codex')).toEqual({
            model: 'gpt-5.6-sol',
            effort: 'high',
            fastMode: 'true'
        });
    });
    it('drops a seeded id whose persisted value is not a usable string', ()=>{
        expect(resolveStructuredLaunchSeedOptions(persistedCodex({
            'gpt-5.6-sol': {
                effort: true
            }
        }), 'codex')).toEqual({
            model: 'gpt-5.6-sol'
        });
        expect(resolveStructuredLaunchSeedOptions(persistedCodex({
            'gpt-5.6-sol': {
                effort: '  '
            }
        }), 'codex')).toEqual({
            model: 'gpt-5.6-sol'
        });
    });
    it('seeds nothing when the stored values empty the model out', ()=>{
        expect(resolveStructuredLaunchSeedOptions(persistedCodex({
            'gpt-5.6-sol': {
                model: ''
            }
        }), 'codex')).toBeUndefined();
    });
    it('seeds nothing until a model is picked, so the CLI default survives', ()=>{
        expect(resolveStructuredLaunchSeedOptions(undefined, 'codex')).toBeUndefined();
        expect(resolveStructuredLaunchSeedOptions({
            codex: {
                valuesByModel: {}
            }
        }, 'codex')).toBeUndefined();
    });
});
describe('narrowStructuredLaunchSeedOptions', ()=>{
    it('keeps the seedable ids an explicit selection names', ()=>{
        expect(narrowStructuredLaunchSeedOptions({
            model: 'opus',
            effort: 'high',
            fastMode: false
        })).toEqual({
            model: 'opus',
            effort: 'high',
            fastMode: 'false'
        });
    });
    it('seeds no fastMode at all when the user never picked one', ()=>{
        expect(narrowStructuredLaunchSeedOptions({
            model: 'opus',
            effort: 'high'
        })).toEqual({
            model: 'opus',
            effort: 'high'
        });
    });
    it('drops ids no structured create may seed', ()=>{
        expect(narrowStructuredLaunchSeedOptions({
            model: 'opus',
            mode: 'plan'
        })).toEqual({
            model: 'opus'
        });
    });
    it.each([
        [
            'nothing at all',
            {}
        ],
        [
            'whitespace only',
            {
                model: '   ',
                effort: '\t'
            }
        ],
        [
            'no usable string',
            {
                model: 5,
                effort: null
            }
        ],
        [
            'undefined',
            undefined
        ]
    ])('resolves %s to undefined rather than {}', (_name, values)=>{
        expect(narrowStructuredLaunchSeedOptions(values)).toBeUndefined();
    });
});
