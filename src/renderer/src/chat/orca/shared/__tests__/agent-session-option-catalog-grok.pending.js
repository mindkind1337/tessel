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
import { getAgentSessionOptionCatalog, mergeCatalogModels, mergeDiscoveredAuthoritativeModels } from "../agent-session-option-catalog.js";
import { GROK_SESSION_OPTION_CATALOG } from "../agent-session-option-catalog-grok.js";
import { resolveAgentSessionOptionLaunch } from "../agent-session-option-launch.js";
import { parseBuiltSessionOptionCommand } from "../native-chat-session-option-commands.js";
function grokEffortOption(modelId = 'grok-4.6') {
    const model = GROK_SESSION_OPTION_CATALOG.models.find((candidate)=>candidate.id === modelId);
    return model.options.find((option)=>option.id === 'effort');
}
function effortValues(option) {
    return option.kind.type === 'select' ? option.kind.choices.map((choice)=>choice.value) : [];
}
describe('grok session option catalog', ()=>{
    it('is registered for the grok agent', ()=>{
        expect(getAgentSessionOptionCatalog('grok')).toBe(GROK_SESSION_OPTION_CATALOG);
    });
    it('seeds only the verified models, defaulting to the newest', ()=>{
        expect(GROK_SESSION_OPTION_CATALOG.models.map(({ id, label, isDefault })=>({
                id,
                label,
                isDefault
            }))).toEqual([
            {
                id: 'grok-4.6',
                label: 'Grok 4.6',
                isDefault: true
            },
            {
                id: 'grok-4.5',
                label: 'Grok 4.5',
                isDefault: undefined
            }
        ]);
    });
    it('keeps the effort option shaped the way the picker and the wire expect', ()=>{
        const effort = grokEffortOption();
        expect(effort.id).toBe('effort');
        expect(effort.category).toBe('thought_level');
        expect(effort.kind).toMatchObject({
            type: 'select',
            defaultValue: 'high'
        });
        expect(grokEffortOption('grok-4.5').kind).toMatchObject({
            defaultValue: 'high'
        });
    });
    it('offers each model only the tiers its own grok menu advertises', ()=>{
        expect(effortValues(grokEffortOption('grok-4.6'))).toEqual([
            'low',
            'medium',
            'high',
            'xhigh'
        ]);
        expect(effortValues(grokEffortOption('grok-4.5'))).toEqual([
            'low',
            'medium',
            'high'
        ]);
    });
    it('offers only effort values the shared option labels localize', ()=>{
        const localized = [
            'minimal',
            'low',
            'medium',
            'high',
            'xhigh',
            'max',
            'ultra'
        ];
        for (const model of GROK_SESSION_OPTION_CATALOG.models){
            for (const value of effortValues(grokEffortOption(model.id))){
                expect(localized).toContain(value);
            }
        }
    });
    it('gives unknown model ids the widest effort menu launch reads from the seed', ()=>{
        const unknown = GROK_SESSION_OPTION_CATALOG.unknownModelOptions ?? [];
        expect(unknown.map(({ id })=>id)).toEqual([
            'effort'
        ]);
        expect(effortValues(unknown[0])).toEqual([
            'low',
            'medium',
            'high',
            'xhigh'
        ]);
    });
    it('treats a successful discovery as authoritative, unlike the other agents', ()=>{
        expect(GROK_SESSION_OPTION_CATALOG.discoveredModelsAreAuthoritative).toBe(true);
        for (const agent of [
            'claude',
            'codex',
            'gemini',
            'cursor'
        ]){
            expect(getAgentSessionOptionCatalog(agent)?.discoveredModelsAreAuthoritative).toBeUndefined();
        }
    });
});
describe('grok launch args', ()=>{
    it('emits the model flag first, then effort', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.5',
            effort: 'low'
        })).toEqual({
            args: [
                '-m',
                'grok-4.5',
                '--reasoning-effort',
                'low'
            ],
            appliedValues: {
                model: 'grok-4.5',
                effort: 'low'
            }
        });
    });
    it('carries the xhigh tier through to argv on a model that advertises it', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.6',
            effort: 'xhigh'
        })).toEqual({
            args: [
                '-m',
                'grok-4.6',
                '--reasoning-effort',
                'xhigh'
            ],
            appliedValues: {
                model: 'grok-4.6',
                effort: 'xhigh'
            }
        });
    });
    it('emits exactly the two model tokens', ()=>{
        expect(GROK_SESSION_OPTION_CATALOG.modelApply.launchArgs('grok-4.6')).toEqual([
            '-m',
            'grok-4.6'
        ]);
    });
    it('falls back to the seeded effort default when none is stored', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.6'
        }).args).toEqual([
            '-m',
            'grok-4.6',
            '--reasoning-effort',
            'high'
        ]);
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.5'
        }).args).toEqual([
            '-m',
            'grok-4.5',
            '--reasoning-effort',
            'high'
        ]);
    });
    it('emits only -m for a persisted model the seed does not carry', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-build'
        })).toEqual({
            args: [
                '-m',
                'grok-build'
            ],
            appliedValues: {
                model: 'grok-build'
            }
        });
    });
    it('carries a picked effort onto a discovered model the seed never listed', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-build',
            effort: 'low'
        })).toEqual({
            args: [
                '-m',
                'grok-build',
                '--reasoning-effort',
                'low'
            ],
            appliedValues: {
                model: 'grok-build',
                effort: 'low'
            }
        });
    });
    it('carries xhigh onto an unseeded model, whose menu is the widest one', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-build',
            effort: 'xhigh'
        })).toEqual({
            args: [
                '-m',
                'grok-build',
                '--reasoning-effort',
                'xhigh'
            ],
            appliedValues: {
                model: 'grok-build',
                effort: 'xhigh'
            }
        });
    });
    it('drops an effort value the menu does not offer on an unseeded model', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-build',
            effort: 'none'
        })).toEqual({
            args: [
                '-m',
                'grok-build'
            ],
            appliedValues: {
                model: 'grok-build'
            }
        });
    });
    it('honors a user effort flag over the picker on an unseeded model too', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-build',
            effort: 'low'
        }, [
            '--reasoning-effort=high'
        ]).appliedValues).toEqual({
            model: 'grok-build'
        });
    });
    it('still adds no effort default for a model the seed does not carry', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-build'
        }).args).toEqual([
            '-m',
            'grok-build'
        ]);
    });
    it('spawns vanilla when no model was ever picked', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', undefined)).toEqual({
            args: [],
            appliedValues: {}
        });
    });
});
describe('grok agentArgsOverride', ()=>{
    const modelOverride = GROK_SESSION_OPTION_CATALOG.modelApply.agentArgsOverride;
    const effortOverride = grokEffortOption().apply.agentArgsOverride;
    it('detects a user-supplied model flag in every spelling', ()=>{
        for (const tokens of [
            [
                '-m',
                'grok-build'
            ],
            [
                '-mgrok-build'
            ],
            [
                '--model',
                'grok-build'
            ],
            [
                '--model=grok-build'
            ]
        ]){
            expect(modelOverride(tokens)).toBe(true);
        }
    });
    it('does not fire on a different flag or a positional that contains -m', ()=>{
        expect(modelOverride([
            '--model-context',
            '8000'
        ])).toBe(false);
        expect(modelOverride([
            'summarize-my-diff'
        ])).toBe(false);
        expect(modelOverride([
            '--reasoning-effort',
            'low'
        ])).toBe(false);
        expect(modelOverride([])).toBe(false);
    });
    it('detects both effort spellings', ()=>{
        expect(effortOverride([
            '--effort',
            'low'
        ])).toBe(true);
        expect(effortOverride([
            '--reasoning-effort=low'
        ])).toBe(true);
        expect(effortOverride([
            '--effortless'
        ])).toBe(false);
    });
    it('drops only the overridden key from the launch record', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.5',
            effort: 'high'
        }, [
            '--reasoning-effort=low'
        ])).toEqual({
            args: [
                '-m',
                'grok-4.5',
                '--reasoning-effort',
                'high'
            ],
            appliedValues: {
                model: 'grok-4.5'
            }
        });
    });
    it('cascades a model override onto the effort entry', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.5',
            effort: 'high'
        }, [
            '-m',
            'grok-build'
        ]).appliedValues).toEqual({});
    });
    it('keeps the record intact when a lookalike flag is present', ()=>{
        expect(resolveAgentSessionOptionLaunch('grok', {
            model: 'grok-4.5',
            effort: 'low'
        }, [
            '--model-context',
            '8000'
        ]).appliedValues).toEqual({
            model: 'grok-4.5',
            effort: 'low'
        });
    });
});
describe('grok mid-session commands', ()=>{
    it('round-trips the model command through the built-command parser', ()=>{
        const midSession = GROK_SESSION_OPTION_CATALOG.modelApply.midSession;
        if (midSession.kind !== 'command') {
            throw new Error('grok model changes must be a typed command, not an agent picker');
        }
        expect(midSession.build('grok-4.5')).toBe('/model grok-4.5');
        expect(parseBuiltSessionOptionCommand(midSession.build, '/model grok-4.5')).toBe('grok-4.5');
        expect(parseBuiltSessionOptionCommand(midSession.build, '/effort low')).toBeNull();
    });
    it('round-trips the effort command', ()=>{
        const midSession = grokEffortOption().apply.midSession;
        if (midSession.kind !== 'command') {
            throw new Error('grok effort changes must be a typed command');
        }
        expect(midSession.build('low')).toBe('/effort low');
        expect(parseBuiltSessionOptionCommand(midSession.build, '/effort low')).toBe('low');
        expect(parseBuiltSessionOptionCommand(midSession.build, '/effort ')).toBeNull();
    });
});
describe('mergeDiscoveredAuthoritativeModels', ()=>{
    const seed = GROK_SESSION_OPTION_CATALOG.models;
    const discovered = (...ids)=>ids.map((id)=>({
                id,
                label: id,
                options: []
            }));
    const mergedEffortValues = (model)=>{
        const effort = model.options.find((option)=>option.id === 'effort');
        return effort?.kind.type === 'select' ? effort.kind.choices.map((choice)=>choice.value) : [];
    };
    it('keeps a matched seed model’s option menu, which discovery never carries', ()=>{
        const merged = mergeDiscoveredAuthoritativeModels(seed, [
            {
                id: 'grok-4.5',
                label: 'Grok 4.5 (live)',
                options: []
            }
        ]);
        expect(merged).toHaveLength(1);
        expect(merged[0]).toMatchObject({
            id: 'grok-4.5',
            label: 'Grok 4.5 (live)'
        });
        expect(mergedEffortValues(merged[0])).toEqual([
            'low',
            'medium',
            'high'
        ]);
    });
    it('takes the default flag from the probe and drops the seed’s stale one', ()=>{
        const merged = mergeDiscoveredAuthoritativeModels(seed, [
            {
                id: 'grok-4.5',
                label: 'Grok 4.5',
                options: []
            },
            {
                id: 'grok-5',
                label: 'Grok 5',
                isDefault: true,
                options: []
            }
        ]);
        expect(merged.map(({ id, isDefault })=>[
                id,
                isDefault
            ])).toEqual([
            [
                'grok-4.5',
                undefined
            ],
            [
                'grok-5',
                true
            ]
        ]);
    });
    it('names no default when the probe marks none, rather than reviving the seed’s', ()=>{
        const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-4.5'));
        expect(merged[0].isDefault).toBeUndefined();
        expect(merged[0].options.map(({ id })=>id)).toEqual([
            'effort'
        ]);
    });
    it('gives a matched seed row its own menu, not the default row’s', ()=>{
        const multiSeed = [
            {
                id: 'grok-4.6',
                label: 'Grok 4.6',
                isDefault: true,
                options: seed[0].options
            },
            {
                id: 'grok-lite',
                label: 'Grok Lite',
                options: []
            }
        ];
        const merged = mergeDiscoveredAuthoritativeModels(multiSeed, discovered('grok-lite'));
        expect(merged.map(({ id })=>id)).toEqual([
            'grok-lite'
        ]);
        expect(merged[0].options).toEqual([]);
    });
    it('drops a seed model the account no longer lists', ()=>{
        const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-build'));
        expect(merged.map(({ id })=>id)).toEqual([
            'grok-build'
        ]);
    });
    it('adds discovered models absent from the seed, lending them the default’s options', ()=>{
        const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-4.5', 'grok-build'));
        expect(merged.map(({ id })=>id)).toEqual([
            'grok-4.5',
            'grok-build'
        ]);
        expect(mergedEffortValues(merged[0])).toEqual([
            'low',
            'medium',
            'high'
        ]);
        expect(mergedEffortValues(merged[1])).toEqual([
            'low',
            'medium',
            'high',
            'xhigh'
        ]);
    });
    it('takes the inherited options from the default seed row, not the first one', ()=>{
        const multiSeed = [
            {
                id: 'legacy',
                label: 'Legacy',
                options: []
            },
            {
                id: 'grok-4.6',
                label: 'Grok 4.6',
                isDefault: true,
                options: seed[0].options
            }
        ];
        const merged = mergeDiscoveredAuthoritativeModels(multiSeed, discovered('grok-build'));
        expect(merged[0].options.map(({ id })=>id)).toEqual([
            'effort'
        ]);
    });
    it('lends no options when the seed is empty', ()=>{
        expect(mergeDiscoveredAuthoritativeModels([], discovered('grok-build'))).toEqual([
            {
                id: 'grok-build',
                label: 'grok-build',
                options: []
            }
        ]);
    });
    it('preserves discovery order rather than seed order', ()=>{
        const merged = mergeDiscoveredAuthoritativeModels(seed, discovered('grok-build', 'grok-4.5'));
        expect(merged.map(({ id })=>id)).toEqual([
            'grok-build',
            'grok-4.5'
        ]);
    });
    it('publishes an empty list for an empty discovery, so callers must gate on it', ()=>{
        expect(mergeDiscoveredAuthoritativeModels(seed, [])).toEqual([]);
    });
    it('drops the unmatched seed row the additive merge would have kept', ()=>{
        expect(mergeCatalogModels(seed, discovered('grok-build')).map(({ id })=>id)).toEqual([
            'grok-4.6',
            'grok-4.5',
            'grok-build'
        ]);
        expect(mergeDiscoveredAuthoritativeModels(seed, discovered('grok-build')).map(({ id })=>id)).toEqual([
            'grok-build'
        ]);
    });
});
