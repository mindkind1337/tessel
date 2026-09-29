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
import { clearNativeChatSessionModel, clearTrackedSessionOption, flattenNativeChatSessionOptionRecord, isFlipOnlyMidSession, matchNativeChatCatalogModelId } from "./native-chat-session-option-state.js";
import { resolveEffectiveNativeChatModelId } from "./native-chat-session-option-snapshot.js";
export function parseBuiltSessionOptionCommand(build, command) {
    const marker = '__orca_session_option_value__';
    const template = build(marker);
    const markerIndex = template.indexOf(marker);
    if (markerIndex === -1) {
        return null;
    }
    const prefix = template.slice(0, markerIndex);
    const suffix = template.slice(markerIndex + marker.length);
    if (!command.startsWith(prefix) || !command.endsWith(suffix)) {
        return null;
    }
    const value = command.slice(prefix.length, command.length - suffix.length).trim();
    return value || null;
}
export function isSessionOptionAgentPickerCommand(midSession, command) {
    return midSession?.kind === 'agent-picker' && command === midSession.command || midSession?.kind === 'command' && command === midSession.pickerCommand;
}
export function buildNativeChatSessionOptionCommand(args) {
    const midSession = args.apply.midSession;
    if (midSession?.kind === 'command') {
        return midSession.build(args.value);
    }
    if (midSession?.kind === 'toggle-command') {
        return midSession.command;
    }
    if (!args.apply.composedIntoModel || !args.modelId || !args.catalog.composeModelValue) {
        return null;
    }
    const model = args.models.find((candidate)=>candidate.id === args.modelId);
    const values = flattenNativeChatSessionOptionRecord(args.record, args.modelId);
    for (const option of model?.options ?? []){
        values[option.id] ??= option.kind.defaultValue;
    }
    values[args.optionId] = args.value;
    const composed = args.catalog.composeModelValue(args.modelId, values);
    return args.catalog.modelApply.midSession?.kind === 'command' ? args.catalog.modelApply.midSession.build(composed) : null;
}
function recordCommandApply(args) {
    const { record, optionId, midSession, command, canonicalize, effectiveModelId, persist } = args;
    if (!midSession || midSession.kind === 'unsupported') {
        return false;
    }
    if (isFlipOnlyMidSession(midSession) && command === midSession.command) {
        clearTrackedSessionOption(record, effectiveModelId, optionId);
        return true;
    }
    if (isSessionOptionAgentPickerCommand(midSession, command)) {
        clearNativeChatSessionModel(record);
        return true;
    }
    if (midSession.kind !== 'command') {
        return false;
    }
    const parsed = parseBuiltSessionOptionCommand(midSession.build, command);
    if (!parsed) {
        return false;
    }
    const value = canonicalize(parsed);
    if (!value) {
        return false;
    }
    const previousModelId = effectiveModelId;
    if (optionId === 'model') {
        if (previousModelId !== value) {
            delete record.valuesByModel[value];
        }
        record.model = {
            value,
            source: 'dispatched'
        };
        persist?.(value, optionId, value);
        return true;
    }
    if (!previousModelId) {
        return true;
    }
    record.valuesByModel[previousModelId] = {
        ...record.valuesByModel[previousModelId],
        [optionId]: {
            value,
            source: 'dispatched'
        }
    };
    persist?.(previousModelId, optionId, value);
    return true;
}
export function recordNativeChatSessionOptionCommand(args) {
    const { catalog, models, record, persist } = args;
    const command = args.command.trim();
    let opensAgentPicker = isSessionOptionAgentPickerCommand(catalog.modelApply.midSession, command);
    let changed = recordCommandApply({
        record,
        optionId: 'model',
        midSession: catalog.modelApply.midSession,
        command,
        canonicalize: (value)=>/\s/.test(value) ? null : matchNativeChatCatalogModelId({
                ...catalog,
                models: [
                    ...models
                ]
            }, value) ?? matchNativeChatCatalogModelId(catalog, value),
        effectiveModelId: resolveEffectiveNativeChatModelId(catalog, models, record),
        persist
    });
    const modelId = resolveEffectiveNativeChatModelId(catalog, models, record);
    const model = modelId ? models.find((candidate)=>candidate.id === modelId) : undefined;
    for (const option of model?.options ?? []){
        opensAgentPicker = opensAgentPicker || isSessionOptionAgentPickerCommand(option.apply.midSession, command);
        changed = recordCommandApply({
            record,
            optionId: option.id,
            midSession: option.apply.midSession,
            command,
            canonicalize: (value)=>option.kind.type === 'select' && !option.kind.choices.some((choice)=>choice.value === value) ? null : value,
            effectiveModelId: modelId,
            persist
        }) || changed;
    }
    return {
        changed,
        opensAgentPicker
    };
}
