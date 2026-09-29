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
import { describe, expect, it, vi } from 'vitest';
import { CLAUDE_SESSION_OPTION_CATALOG, CODEX_SESSION_OPTION_CATALOG } from "../agent-session-option-catalog-claude-codex.js";
import { GROK_SESSION_OPTION_CATALOG } from "../agent-session-option-catalog-grok.js";
import { buildNativeChatSessionOptionCommand, parseBuiltSessionOptionCommand, recordNativeChatSessionOptionCommand } from "../native-chat-session-option-commands.js";
import { createNativeChatSessionOptionRecord } from "../native-chat-session-option-state.js";
function claudeRecord(model) {
    const record = createNativeChatSessionOptionRecord('claude');
    if (model) {
        record.model = {
            value: model,
            source: 'dispatched'
        };
    }
    return record;
}
describe('buildNativeChatSessionOptionCommand', ()=>{
    it('builds the catalog midSession command for model and options', ()=>{
        expect(buildNativeChatSessionOptionCommand({
            optionId: 'model',
            value: 'opus',
            apply: CLAUDE_SESSION_OPTION_CATALOG.modelApply,
            modelId: null,
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record: claudeRecord()
        })).toBe('/model opus');
        const effortApply = CLAUDE_SESSION_OPTION_CATALOG.models.find((model)=>model.id === 'sonnet').options.find((option)=>option.id === 'effort').apply;
        expect(buildNativeChatSessionOptionCommand({
            optionId: 'effort',
            value: 'high',
            apply: effortApply,
            modelId: 'sonnet',
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record: claudeRecord('sonnet')
        })).toBe('/effort high');
    });
    it('returns the bare toggle command for flip-only options', ()=>{
        const fastModeApply = CLAUDE_SESSION_OPTION_CATALOG.models.find((model)=>model.id === 'opus').options.find((option)=>option.id === 'fastMode').apply;
        expect(buildNativeChatSessionOptionCommand({
            optionId: 'fastMode',
            value: true,
            apply: fastModeApply,
            modelId: 'opus',
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record: claudeRecord('opus')
        })).toBe('/fast');
    });
    it('does not turn a Codex model pick into pasted slash-command prose', ()=>{
        expect(buildNativeChatSessionOptionCommand({
            optionId: 'model',
            value: 'gpt-5.5',
            apply: CODEX_SESSION_OPTION_CATALOG.modelApply,
            modelId: null,
            catalog: CODEX_SESSION_OPTION_CATALOG,
            models: CODEX_SESSION_OPTION_CATALOG.models,
            record: createNativeChatSessionOptionRecord('codex')
        })).toBeNull();
        expect(CODEX_SESSION_OPTION_CATALOG.modelApply.midSession).toEqual({
            kind: 'agent-picker',
            command: '/model',
            delivery: 'type'
        });
    });
});
describe('parseBuiltSessionOptionCommand', ()=>{
    it('recovers the value from a built command and rejects other text', ()=>{
        const build = (value)=>`/model ${String(value)}`;
        expect(parseBuiltSessionOptionCommand(build, '/model opus')).toBe('opus');
        expect(parseBuiltSessionOptionCommand(build, '/effort high')).toBeNull();
        expect(parseBuiltSessionOptionCommand(build, '/model ')).toBeNull();
    });
});
describe('recordNativeChatSessionOptionCommand', ()=>{
    it('tracks a typed /model value as dispatched truth', ()=>{
        const record = claudeRecord();
        const result = recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/model sonnet'
        });
        expect(result).toEqual({
            changed: true,
            opensAgentPicker: false
        });
        expect(record.model).toEqual({
            value: 'sonnet',
            source: 'dispatched'
        });
    });
    it('tracks a typed option value under the current model', ()=>{
        const record = claudeRecord('sonnet');
        recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/effort low'
        });
        expect(record.valuesByModel.sonnet?.effort).toEqual({
            value: 'low',
            source: 'dispatched'
        });
    });
    it('clears tracked truth for a bare picker command and reports the agent picker', ()=>{
        const claudeResult = recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record: claudeRecord('sonnet'),
            command: '/model'
        });
        expect(claudeResult.opensAgentPicker).toBe(true);
        const codexRecord = createNativeChatSessionOptionRecord('codex');
        codexRecord.model = {
            value: 'gpt-5.5',
            source: 'dispatched'
        };
        const codexResult = recordNativeChatSessionOptionCommand({
            catalog: CODEX_SESSION_OPTION_CATALOG,
            models: CODEX_SESSION_OPTION_CATALOG.models,
            record: codexRecord,
            command: '/model'
        });
        expect(codexResult).toEqual({
            changed: true,
            opensAgentPicker: true
        });
        expect(codexRecord.model).toBeUndefined();
    });
    it('clears a flip-only toggle’s tracked baseline on a typed flip', ()=>{
        const record = claudeRecord('opus');
        record.valuesByModel.opus = {
            fastMode: {
                value: true,
                source: 'applied'
            }
        };
        recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/fast'
        });
        expect(record.valuesByModel.opus?.fastMode).toBeUndefined();
    });
    it('rejects prose that merely starts with a command template', ()=>{
        const record = claudeRecord('sonnet');
        expect(recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/model is a weird word'
        })).toEqual({
            changed: false,
            opensAgentPicker: false
        });
        expect(record.model).toEqual({
            value: 'sonnet',
            source: 'dispatched'
        });
    });
    it('rejects an option value outside the catalog choices', ()=>{
        const record = claudeRecord('sonnet');
        recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/effort of will is required'
        });
        expect(record.valuesByModel.sonnet?.effort).toBeUndefined();
    });
    it('tracks nothing for a multi-line paste whose first line looks like a command', ()=>{
        const record = claudeRecord('opus');
        recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/model sonnet\nplease review this'
        });
        expect(record.model).toEqual({
            value: 'opus',
            source: 'dispatched'
        });
    });
    it('still accepts an alias, a full provider id, and extra spacing', ()=>{
        for (const [command, expected] of [
            [
                '/model opus',
                'opus'
            ],
            [
                '/model claude-sonnet-5',
                'sonnet'
            ],
            [
                '/model  sonnet',
                'sonnet'
            ]
        ]){
            const record = claudeRecord();
            recordNativeChatSessionOptionCommand({
                catalog: CLAUDE_SESSION_OPTION_CATALOG,
                models: CLAUDE_SESSION_OPTION_CATALOG.models,
                record,
                command
            });
            expect(record.model).toEqual({
                value: expected,
                source: 'dispatched'
            });
        }
    });
    it('still tracks an alias the active model list no longer carries', ()=>{
        const record = claudeRecord('sonnet');
        const discovered = CLAUDE_SESSION_OPTION_CATALOG.models.filter((model)=>model.id !== 'opus');
        recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: discovered,
            record,
            command: '/model opus'
        });
        expect(record.model).toEqual({
            value: 'opus',
            source: 'dispatched'
        });
    });
    it('ignores unrelated commands', ()=>{
        const record = claudeRecord('sonnet');
        expect(recordNativeChatSessionOptionCommand({
            catalog: CLAUDE_SESSION_OPTION_CATALOG,
            models: CLAUDE_SESSION_OPTION_CATALOG.models,
            record,
            command: '/clear'
        })).toEqual({
            changed: false,
            opensAgentPicker: false
        });
    });
});
describe('recordNativeChatSessionOptionCommand for grok', ()=>{
    function grokRecord(model) {
        const record = createNativeChatSessionOptionRecord('grok');
        if (model) {
            record.model = {
                value: model,
                source: 'dispatched'
            };
        }
        return record;
    }
    function recordGrok(record, command) {
        return recordNativeChatSessionOptionCommand({
            catalog: GROK_SESSION_OPTION_CATALOG,
            models: GROK_SESSION_OPTION_CATALOG.models,
            record,
            command
        });
    }
    it('tracks a typed /model without signalling an agent picker', ()=>{
        const record = grokRecord();
        expect(recordGrok(record, '/model grok-4.5')).toEqual({
            changed: true,
            opensAgentPicker: false
        });
        expect(record.model).toEqual({
            value: 'grok-4.5',
            source: 'dispatched'
        });
    });
    it('persists the typed model through the caller’s persist hook', ()=>{
        const persist = vi.fn();
        recordNativeChatSessionOptionCommand({
            catalog: GROK_SESSION_OPTION_CATALOG,
            models: GROK_SESSION_OPTION_CATALOG.models,
            record: grokRecord(),
            command: '/model grok-4.5',
            persist
        });
        expect(persist).toHaveBeenCalledWith('grok-4.5', 'model', 'grok-4.5');
    });
    it('tracks effort under the current model', ()=>{
        const record = grokRecord('grok-4.5');
        expect(recordGrok(record, '/effort medium')).toEqual({
            changed: true,
            opensAgentPicker: false
        });
        expect(record.valuesByModel['grok-4.5']?.effort).toEqual({
            value: 'medium',
            source: 'dispatched'
        });
    });
    it('tracks nothing for an effort tier outside the seeded choices', ()=>{
        const record = grokRecord('grok-4.5');
        recordGrok(record, '/effort none');
        expect(record.valuesByModel['grok-4.5']?.effort).toBeUndefined();
    });
    it('gates xhigh on the tracked model’s own menu, not grok’s canonical ladder', ()=>{
        const older = grokRecord('grok-4.5');
        recordGrok(older, '/effort xhigh');
        expect(older.valuesByModel['grok-4.5']?.effort).toBeUndefined();
        const newer = grokRecord('grok-4.6');
        recordGrok(newer, '/effort xhigh');
        expect(newer.valuesByModel['grok-4.6']?.effort).toEqual({
            value: 'xhigh',
            source: 'dispatched'
        });
    });
    it('rejects grok’s two-argument /model form and any other prose', ()=>{
        const record = grokRecord('grok-4.5');
        expect(recordGrok(record, '/model Reasoning X high')).toEqual({
            changed: false,
            opensAgentPicker: false
        });
        expect(record.model).toEqual({
            value: 'grok-4.5',
            source: 'dispatched'
        });
    });
    it('does not open an agent picker for a bare /model', ()=>{
        const record = grokRecord('grok-4.5');
        expect(recordGrok(record, '/model')).toEqual({
            changed: false,
            opensAgentPicker: false
        });
        expect(record.model).toEqual({
            value: 'grok-4.5',
            source: 'dispatched'
        });
    });
    it('tracks a typed effort under the CLI default when no model was picked', ()=>{
        const record = grokRecord();
        const persist = vi.fn();
        expect(recordNativeChatSessionOptionCommand({
            catalog: GROK_SESSION_OPTION_CATALOG,
            models: GROK_SESSION_OPTION_CATALOG.models,
            record,
            command: '/effort low',
            persist
        })).toEqual({
            changed: true,
            opensAgentPicker: false
        });
        expect(record.valuesByModel['grok-4.6']?.effort).toEqual({
            value: 'low',
            source: 'dispatched'
        });
        expect(persist).toHaveBeenCalledWith('grok-4.6', 'effort', 'low');
    });
    it('does not reset tracked state when the typed model is the CLI default already shown', ()=>{
        const record = grokRecord();
        recordGrok(record, '/effort low');
        recordGrok(record, '/model grok-4.6');
        expect(record.valuesByModel['grok-4.6']?.effort).toEqual({
            value: 'low',
            source: 'dispatched'
        });
    });
    it('still resets tracked state when the typed model is a real switch', ()=>{
        const record = grokRecord();
        recordGrok(record, '/effort low');
        recordNativeChatSessionOptionCommand({
            catalog: GROK_SESSION_OPTION_CATALOG,
            models: [
                ...GROK_SESSION_OPTION_CATALOG.models,
                {
                    id: 'grok-build',
                    label: 'Grok Build',
                    options: []
                }
            ],
            record,
            command: '/model grok-build'
        });
        expect(record.model).toEqual({
            value: 'grok-build',
            source: 'dispatched'
        });
        expect(record.valuesByModel['grok-4.6']?.effort).toEqual({
            value: 'low',
            source: 'dispatched'
        });
    });
    it('still tracks a model the discovered list dropped', ()=>{
        const record = grokRecord();
        recordNativeChatSessionOptionCommand({
            catalog: GROK_SESSION_OPTION_CATALOG,
            models: [
                {
                    id: 'grok-build',
                    label: 'Grok Build',
                    options: []
                }
            ],
            record,
            command: '/model grok-4.5'
        });
        expect(record.model).toEqual({
            value: 'grok-4.5',
            source: 'dispatched'
        });
    });
});
