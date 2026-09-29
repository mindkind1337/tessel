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
export function createNativeChatSessionOptionRecord(agent) {
    return {
        agent,
        valuesByModel: {}
    };
}
export function cloneNativeChatSessionOptionRecord(record) {
    return {
        agent: record.agent,
        ...record.model ? {
            model: {
                ...record.model
            }
        } : {},
        valuesByModel: Object.fromEntries(Object.entries(record.valuesByModel).map(([modelId, values])=>[
                modelId,
                Object.fromEntries(Object.entries(values).map(([id, tracked])=>[
                        id,
                        {
                            ...tracked
                        }
                    ]))
            ]))
    };
}
export function isFlipOnlyMidSession(midSession) {
    return midSession?.kind === 'toggle-command';
}
export function getTrackedSessionOption(record, modelId, optionId) {
    return modelId ? record.valuesByModel[modelId]?.[optionId] : undefined;
}
export function clearTrackedSessionOption(record, modelId, optionId) {
    if (!modelId) {
        return;
    }
    const current = record.valuesByModel[modelId];
    if (!current || !(optionId in current)) {
        return;
    }
    const next = {
        ...current
    };
    delete next[optionId];
    if (Object.keys(next).length === 0) {
        delete record.valuesByModel[modelId];
    } else {
        record.valuesByModel[modelId] = next;
    }
}
export function clearNativeChatSessionModel(record) {
    const modelId = typeof record.model?.value === 'string' ? record.model.value : null;
    record.model = undefined;
    if (modelId) {
        delete record.valuesByModel[modelId];
    }
}
export function setTrackedSessionOption(record, optionId, value, source, fallbackModelId = null) {
    if (optionId === 'model') {
        record.model = {
            value,
            source
        };
        return typeof value === 'string' ? value : null;
    }
    const modelId = (typeof record.model?.value === 'string' ? record.model.value : null) ?? fallbackModelId;
    if (!modelId) {
        return null;
    }
    record.valuesByModel[modelId] = {
        ...record.valuesByModel[modelId],
        [optionId]: {
            value,
            source
        }
    };
    return modelId;
}
export function flattenNativeChatSessionOptionRecord(record, modelId) {
    return {
        model: modelId,
        ...Object.fromEntries(Object.entries(record.valuesByModel[modelId] ?? {}).map(([id, tracked])=>[
                id,
                tracked.value
            ]))
    };
}
export function applyNativeChatReportedSessionOptions(record, values, confirmed) {
    const sourceFor = (id)=>confirmed === undefined || confirmed.includes(id) ? 'reported' : 'dispatched';
    const modelId = typeof values.model === 'string' ? values.model : null;
    if (!modelId) {
        return false;
    }
    const modelChanged = record.model?.value !== modelId;
    let changed = modelChanged || record.model?.source !== sourceFor('model');
    record.model = {
        value: modelId,
        source: sourceFor('model')
    };
    const modelValues = modelChanged ? {} : {
        ...record.valuesByModel[modelId]
    };
    for (const [id, value] of Object.entries(values)){
        if (id === 'model') {
            continue;
        }
        const current = modelValues[id];
        if (current?.value !== value || current.source !== sourceFor(id)) {
            changed = true;
        }
        modelValues[id] = {
            value,
            source: sourceFor(id)
        };
    }
    record.valuesByModel[modelId] = modelValues;
    return changed;
}
export function matchNativeChatCatalogModelId(catalog, reported) {
    const normalized = reported.trim().toLowerCase();
    if (!normalized) {
        return null;
    }
    if (catalog.models.length === 0) {
        return reported.trim();
    }
    const exact = catalog.models.find((model)=>model.id.toLowerCase() === normalized);
    if (exact) {
        return exact.id;
    }
    const byLabel = catalog.models.find((model)=>model.label.toLowerCase() === normalized);
    if (byLabel) {
        return byLabel.id;
    }
    let containingId = null;
    for (const model of catalog.models){
        if ((containingId === null || model.id.length > containingId.length) && normalized.includes(model.id.toLowerCase())) {
            containingId = model.id;
        }
    }
    return containingId;
}
