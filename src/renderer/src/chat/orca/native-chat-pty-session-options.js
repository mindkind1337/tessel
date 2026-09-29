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
import { getAgentSessionOptionCatalog } from "./shared/agent-session-option-catalog.js";
import { recordNativeChatSessionOptionCommand } from "./shared/native-chat-session-option-commands.js";
import { applyNativeChatReportedSessionOptions, clearNativeChatSessionModel, createNativeChatSessionOptionRecord, setTrackedSessionOption } from "./shared/native-chat-session-option-state.js";
import { readNativeChatSessionOptionCache, writeNativeChatSessionOptionCache } from "./native-chat-session-option-cache.js";
import { createSessionOptionAppliers } from "./native-chat-session-option-apply.js";
import { buildNativeChatSessionOptionSnapshot, resolveEffectiveNativeChatModelId, withTrackedNativeChatModel } from "./native-chat-session-option-snapshot.js";
export function createNativeChatPtySessionOptions(args) {
    const baseCatalog = getAgentSessionOptionCatalog(args.agent);
    if (!baseCatalog) {
        return null;
    }
    const catalog = args.agent === 'omp' && args.mode === 'live' && !args.canSwitchOmpModel ? {
        ...baseCatalog,
        modelApply: {
            ...baseCatalog.modelApply,
            midSession: undefined
        }
    } : baseCatalog;
    let models = [
        ...args.initialModels ?? catalog.models
    ];
    let modelsAreDiscovered = args.initialModels !== undefined;
    let record = readNativeChatSessionOptionCache(args.scopeKey, args.fallbackScopeKey) ?? createNativeChatSessionOptionRecord(args.agent);
    if (record.agent !== args.agent) {
        record = createNativeChatSessionOptionRecord(args.agent);
    }
    if (args.reportedValues && applyNativeChatReportedSessionOptions(record, args.reportedValues)) {
        writeNativeChatSessionOptionCache(args.scopeKey, record);
    }
    const untrackRetiredModel = ()=>{
        if (!catalog.discoveredModelsAreAuthoritative || !modelsAreDiscovered) {
            return false;
        }
        const trackedId = typeof record.model?.value === 'string' ? record.model.value : null;
        if (!trackedId || models.some((model)=>model.id === trackedId)) {
            return false;
        }
        clearNativeChatSessionModel(record);
        return true;
    };
    if (untrackRetiredModel()) {
        writeNativeChatSessionOptionCache(args.scopeKey, record);
    }
    const activeModels = ()=>withTrackedNativeChatModel(catalog, models, record);
    let snapshot = buildNativeChatSessionOptionSnapshot({
        catalog,
        models: activeModels(),
        record,
        mode: args.mode,
        liveTransport: 'catalog'
    });
    const listeners = new Set();
    const publish = ()=>{
        writeNativeChatSessionOptionCache(args.scopeKey, record);
        snapshot = buildNativeChatSessionOptionSnapshot({
            catalog,
            models: activeModels(),
            record,
            mode: args.mode,
            liveTransport: 'catalog'
        });
        for (const listener of listeners){
            listener(snapshot);
        }
        return snapshot;
    };
    const clearModelTruth = ()=>{
        clearNativeChatSessionModel(record);
    };
    const setTrackedValue = (optionId, value, source)=>setTrackedSessionOption(record, optionId, value, source, resolveEffectiveNativeChatModelId(catalog, activeModels(), record));
    const modelIsAdoptableAsLaunchDefault = (modelId)=>{
        const listedIn = (list)=>list.some((model)=>model.id === modelId);
        if (!listedIn(models) && !listedIn(catalog.models)) {
            return false;
        }
        return modelsAreDiscovered ? !catalog.discoveredModelsAreAuthoritative || listedIn(models) : record.model !== undefined;
    };
    const persist = (modelId, optionId, value)=>{
        if (modelId) {
            void args.persistSelection?.({
                modelId,
                optionId,
                value,
                adoptModelAsLaunchDefault: modelIsAdoptableAsLaunchDefault(modelId)
            });
        }
    };
    const appliers = createSessionOptionAppliers({
        mode: args.mode,
        catalog,
        getModels: activeModels,
        getRecord: ()=>record,
        dispatchCommand: args.dispatchCommand,
        onAgentPicker: args.onAgentPicker,
        persist,
        onDraftValuesChanged: args.onDraftValuesChanged,
        publish,
        clearModelTruth,
        setTrackedValue
    });
    return {
        getSnapshot: ()=>snapshot,
        setOption: appliers.setOption,
        invokeAction: appliers.invokeAction,
        subscribe: (listener)=>{
            listeners.add(listener);
            return ()=>listeners.delete(listener);
        },
        recordOutgoingCommand: (command)=>{
            const result = recordNativeChatSessionOptionCommand({
                catalog,
                models: activeModels(),
                record,
                command,
                persist
            });
            if (result.changed) {
                publish();
            }
            if (result.opensAgentPicker) {
                args.onAgentPicker?.();
            }
        },
        reportSessionOptions: (values)=>{
            if (applyNativeChatReportedSessionOptions(record, values)) {
                publish();
            }
        },
        replaceModels: (nextModels)=>{
            models = [
                ...nextModels
            ];
            modelsAreDiscovered = true;
            untrackRetiredModel();
            publish();
        }
    };
}
