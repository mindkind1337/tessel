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
import { findCatalogModel, findCatalogOption } from "./shared/agent-session-option-catalog.js";
import { buildNativeChatSessionOptionCommand } from "./shared/native-chat-session-option-commands.js";
import { getTrackedSessionOption as getTrackedOption, isFlipOnlyMidSession } from "./shared/native-chat-session-option-state.js";
import { flattenNativeChatSessionOptionRecord, resolveEffectiveNativeChatModelId } from "./native-chat-session-option-snapshot.js";
function createSerializedApplyQueue() {
    let tail = Promise.resolve();
    return (fn)=>{
        const run = tail.then(fn, fn);
        tail = run.then(()=>undefined, ()=>undefined);
        return run;
    };
}
function currentApply(ctx, optionId) {
    const models = ctx.getModels();
    const modelId = resolveEffectiveNativeChatModelId(ctx.catalog, models, ctx.getRecord());
    if (optionId === 'model') {
        return {
            apply: ctx.catalog.modelApply,
            modelId
        };
    }
    const model = modelId ? findCatalogModel({
        ...ctx.catalog,
        models
    }, modelId) : undefined;
    const option = findCatalogOption(model, optionId);
    return option ? {
        apply: option.apply,
        modelId
    } : null;
}
function trackedModelId(record) {
    return typeof record.model?.value === 'string' ? record.model.value : null;
}
function finish(ctx, args) {
    if (args && !args.skipPersist) {
        ctx.persist(args.modelId, args.optionId, args.value);
    }
    const snapshot = ctx.publish();
    const record = ctx.getRecord();
    const draftModelId = trackedModelId(record);
    if (ctx.mode === 'draft' && draftModelId !== null) {
        ctx.onDraftValuesChanged?.(flattenNativeChatSessionOptionRecord(record, draftModelId));
    }
    return {
        snapshot
    };
}
async function handleAgentPicker(ctx, midSession) {
    await (midSession.delivery ? ctx.dispatchCommand(midSession.command, {
        delivery: midSession.delivery
    }) : ctx.dispatchCommand(midSession.command));
    ctx.clearModelTruth();
    const snapshot = ctx.publish();
    ctx.onAgentPicker?.();
    return {
        snapshot
    };
}
async function dispatchLiveCommand(ctx, args) {
    const models = ctx.getModels();
    const record = ctx.getRecord();
    const command = buildNativeChatSessionOptionCommand({
        optionId: args.optionId,
        value: args.value,
        apply: args.apply,
        modelId: args.modelId,
        catalog: ctx.catalog,
        models,
        record
    });
    if (!command) {
        throw new Error('This option can only be set when the session starts.');
    }
    const detectAgentInteraction = args.apply.midSession?.kind === 'command' ? args.apply.midSession.detectAgentInteraction : args.apply.composedIntoModel && ctx.catalog.modelApply.midSession?.kind === 'command' ? ctx.catalog.modelApply.midSession.detectAgentInteraction : undefined;
    const expectedChoiceLabel = args.optionId === 'model' && typeof args.value === 'string' ? findCatalogModel({
        ...ctx.catalog,
        models
    }, args.value)?.label ?? args.value : undefined;
    return detectAgentInteraction ? await ctx.dispatchCommand(command, {
        detectAgentInteraction,
        expectedChoiceLabel
    }) : await ctx.dispatchCommand(command);
}
function applyDispatchOutcome(ctx, dispatchResult) {
    if (dispatchResult?.outcome === 'rejected') {
        throw new Error('Claude kept the current model.');
    }
    if (dispatchResult?.outcome === 'unknown') {
        ctx.clearModelTruth();
        ctx.publish();
        throw new Error('Could not verify the model change; open the terminal to check.');
    }
    return null;
}
async function applySetOption(ctx, id, value) {
    const resolved = currentApply(ctx, id);
    if (!resolved) {
        throw new Error(`Unknown session option: ${id}`);
    }
    const { apply, modelId: previousModelId } = resolved;
    if (ctx.mode === 'live' && apply.midSession?.kind === 'agent-picker') {
        throw new Error('This option must be changed in the agent picker.');
    }
    const liveFlipOnly = ctx.mode === 'live' && isFlipOnlyMidSession(apply.midSession);
    const trackedToggle = liveFlipOnly ? getTrackedOption(ctx.getRecord(), previousModelId, id) : undefined;
    if (liveFlipOnly && !trackedToggle) {
        throw new Error('Current value is unknown; use the Toggle action instead.');
    }
    if (liveFlipOnly && trackedToggle?.value === value) {
        return {
            snapshot: ctx.publish()
        };
    }
    const source = liveFlipOnly || ctx.mode !== 'live' ? 'applied' : 'dispatched';
    const trackedModelBeforeDispatch = trackedModelId(ctx.getRecord());
    const trackedBeforeDispatch = ctx.mode === 'live' && id !== 'model' ? getTrackedOption(ctx.getRecord(), previousModelId, id) : undefined;
    let dispatchResult = undefined;
    if (ctx.mode === 'live') {
        dispatchResult = await dispatchLiveCommand(ctx, {
            optionId: id,
            value,
            apply,
            modelId: previousModelId
        });
    } else if (!apply.launchArgs && !apply.composedIntoModel) {
        throw new Error('This option is only available after the session starts.');
    }
    const early = applyDispatchOutcome(ctx, dispatchResult);
    if (early) {
        return early;
    }
    const record = ctx.getRecord();
    if (id === 'model' && previousModelId !== value) {
        record.model = undefined;
        if (ctx.mode === 'live' && typeof value === 'string') {
            delete record.valuesByModel[value];
        }
    }
    if (liveFlipOnly) {
        if (trackedModelId(record) !== trackedModelBeforeDispatch) {
            return finish(ctx, {
                modelId: previousModelId,
                optionId: id,
                value,
                skipPersist: true
            });
        }
        if (getTrackedOption(record, previousModelId, id) !== trackedToggle) {
            return finish(ctx, {
                modelId: previousModelId,
                optionId: id,
                value,
                skipPersist: true
            });
        }
        ctx.setTrackedValue(id, value, source);
        return finish(ctx, {
            modelId: previousModelId,
            optionId: id,
            value,
            skipPersist: true
        });
    }
    if (ctx.mode === 'live' && id !== 'model') {
        if (trackedModelId(record) !== trackedModelBeforeDispatch || getTrackedOption(record, previousModelId, id) !== trackedBeforeDispatch) {
            return finish(ctx, {
                modelId: previousModelId,
                optionId: id,
                value,
                skipPersist: true
            });
        }
    }
    const modelId = ctx.setTrackedValue(id, value, source);
    return finish(ctx, {
        modelId: modelId ?? previousModelId,
        optionId: id,
        value
    });
}
async function applyInvokeAction(ctx, id) {
    const resolved = currentApply(ctx, id);
    if (!resolved) {
        throw new Error(`Unknown session option: ${id}`);
    }
    const { apply, modelId } = resolved;
    if (apply.midSession?.kind === 'agent-picker') {
        if (ctx.mode !== 'live') {
            throw new Error('This option is only available after the session starts.');
        }
        return handleAgentPicker(ctx, apply.midSession);
    }
    if (!isFlipOnlyMidSession(apply.midSession)) {
        throw new Error('This option requires a value.');
    }
    if (ctx.mode !== 'live') {
        throw new Error('This option is only available after the session starts.');
    }
    if (getTrackedOption(ctx.getRecord(), modelId, id)) {
        throw new Error('This option has a known value; choose On or Off instead.');
    }
    await ctx.dispatchCommand(apply.midSession.command);
    return finish(ctx);
}
export function createSessionOptionAppliers(ctx) {
    const serialize = createSerializedApplyQueue();
    return {
        setOption: (id, value)=>serialize(()=>applySetOption(ctx, id, value)),
        invokeAction: (id)=>serialize(()=>applyInvokeAction(ctx, id))
    };
}
