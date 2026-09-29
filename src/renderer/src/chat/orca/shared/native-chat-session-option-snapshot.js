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
import { isFlipOnlyMidSession } from "./native-chat-session-option-state.js";
function choiceWithCurrent(choices, tracked) {
    const result = [
        ...choices
    ];
    const current = typeof tracked?.value === 'string' ? tracked.value : null;
    if (current && !result.some((choice)=>choice.value === current)) {
        result.push({
            value: current,
            label: current
        });
    }
    return result;
}
function settableState(args) {
    if (args.mode === 'draft') {
        return args.apply.launchArgs || args.apply.composedIntoModel ? {
            settable: true
        } : {
            settable: false,
            disabledReason: 'available-after-session-start'
        };
    }
    if (args.liveTransport === 'agent-session') {
        return {
            settable: true
        };
    }
    if (args.apply.composedIntoModel && args.composedModelApply?.midSession?.kind === 'command') {
        return {
            settable: true
        };
    }
    const midSession = args.apply.midSession;
    return midSession && midSession.kind !== 'unsupported' ? {
        settable: true
    } : {
        settable: false,
        disabledReason: 'set-when-session-starts'
    };
}
function actionForApply(apply, tracked, mode, liveTransport) {
    if (mode !== 'live' || liveTransport === 'agent-session') {
        return undefined;
    }
    if (apply.midSession?.kind === 'agent-picker') {
        return {
            type: 'agent-picker'
        };
    }
    return isFlipOnlyMidSession(apply.midSession) && !tracked ? {
        type: 'toggle-command'
    } : undefined;
}
function optionDescriptor(args) {
    const { option, tracked, mode, liveTransport, modelIsCliDefault, composedModelApply } = args;
    const action = actionForApply(option.apply, tracked, mode, liveTransport);
    const settable = settableState({
        mode,
        liveTransport,
        apply: option.apply,
        composedModelApply
    });
    const cliStatesDefault = modelIsCliDefault && option.kind.type === 'select' && option.kind.defaultIsCliDefault === true;
    const showDefault = !tracked && (cliStatesDefault || mode === 'draft' && !modelIsCliDefault);
    const valueSource = tracked?.source ?? (showDefault ? 'default' : 'unknown');
    if (option.kind.type === 'select') {
        const choices = choiceWithCurrent(option.kind.choices, tracked);
        if (choices.length <= 1) {
            return null;
        }
        const currentValue = typeof tracked?.value === 'string' ? tracked.value : showDefault ? option.kind.defaultValue : undefined;
        return {
            id: option.id,
            label: option.label,
            ...option.description ? {
                description: option.description
            } : {},
            ...option.category ? {
                category: option.category
            } : {},
            kind: {
                type: 'select',
                ...currentValue === undefined ? {} : {
                    currentValue
                },
                choices
            },
            valueSource,
            transport: liveTransport,
            ...settable,
            ...action ? {
                action
            } : {}
        };
    }
    const currentValue = typeof tracked?.value === 'boolean' ? tracked.value : option.kind.defaultValue;
    return {
        id: option.id,
        label: option.label,
        ...option.description ? {
            description: option.description
        } : {},
        ...option.category ? {
            category: option.category
        } : {},
        kind: {
            type: 'boolean',
            currentValue
        },
        valueSource,
        transport: liveTransport,
        ...settable,
        ...action ? {
            action
        } : {}
    };
}
const CATEGORY_ORDER = {
    thought_level: 0,
    model_config: 1,
    mode: 2
};
export function sortNativeChatSessionOptions(snapshot) {
    return snapshot.filter((descriptor)=>descriptor.category !== 'model').sort((left, right)=>{
        const leftOrder = CATEGORY_ORDER[left.category ?? ''] ?? 3;
        const rightOrder = CATEGORY_ORDER[right.category ?? ''] ?? 3;
        return leftOrder - rightOrder;
    });
}
export function withTrackedNativeChatModel(catalog, models, record) {
    const trackedId = typeof record.model?.value === 'string' ? record.model.value : null;
    if (!trackedId || models.some((model)=>model.id === trackedId)) {
        return [
            ...models
        ];
    }
    const seeded = catalog.models.find((model)=>model.id === trackedId);
    return [
        ...models,
        seeded ?? {
            id: trackedId,
            label: trackedId,
            options: []
        }
    ];
}
function cliDefaultModelId(catalog, models, trackedModelId) {
    if (trackedModelId || !catalog.defaultModelIsCliDefault) {
        return null;
    }
    return models.find((model)=>model.isDefault)?.id ?? null;
}
export function resolveEffectiveNativeChatModelId(catalog, models, record) {
    const trackedModelId = typeof record.model?.value === 'string' ? record.model.value : null;
    return trackedModelId ?? cliDefaultModelId(catalog, models, trackedModelId);
}
export function buildNativeChatSessionOptionSnapshot(args) {
    const { catalog, models, record, mode, modelLabel, liveTransport } = args;
    if (models.length === 0) {
        return [];
    }
    const modelTracked = record.model;
    const modelChoices = models.map(({ id, label, description })=>({
            value: id,
            label,
            ...description ? {
                description
            } : {}
        }));
    const trackedModelId = typeof modelTracked?.value === 'string' ? modelTracked.value : null;
    const defaultModelId = cliDefaultModelId(catalog, models, trackedModelId);
    const effectiveModelId = trackedModelId ?? defaultModelId;
    const modelAction = actionForApply(catalog.modelApply, modelTracked, mode, liveTransport);
    const snapshot = [
        {
            id: 'model',
            label: modelLabel,
            category: 'model',
            kind: {
                type: 'select',
                ...effectiveModelId ? {
                    currentValue: effectiveModelId
                } : {},
                choices: modelChoices
            },
            valueSource: modelTracked?.source ?? (defaultModelId ? 'default' : 'unknown'),
            transport: liveTransport,
            ...settableState({
                mode,
                liveTransport,
                apply: catalog.modelApply
            }),
            ...modelAction ? {
                action: modelAction
            } : {}
        }
    ];
    if (!effectiveModelId) {
        return snapshot;
    }
    const model = models.find((candidate)=>candidate.id === effectiveModelId);
    const trackedValues = record.valuesByModel[effectiveModelId] ?? {};
    for (const option of model?.options ?? []){
        const descriptor = optionDescriptor({
            option,
            tracked: trackedValues[option.id],
            mode,
            liveTransport,
            modelIsCliDefault: effectiveModelId === defaultModelId,
            composedModelApply: catalog.modelApply
        });
        if (descriptor) {
            snapshot.push(descriptor);
        }
    }
    return snapshot;
}
