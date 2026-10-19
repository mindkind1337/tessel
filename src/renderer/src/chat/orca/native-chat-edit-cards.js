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
import { editFilesFromToolPair, editSummariesFromToolPair, isEditToolName } from "./shared/native-chat-edit-normalize.js";
import { editFilesFromPatchText } from "./shared/native-chat-edit-patch-files.js";
import { pairToolBlocks } from "./native-chat-tool-fold.js";
const normalizedEdits = new WeakMap();
function normalizedEditFiles(call, result, derive) {
    const cached = normalizedEdits.get(call);
    if (cached && cached.result === result) {
        return cached.files;
    }
    const files = derive();
    normalizedEdits.set(call, {
        result,
        files
    });
    return files;
}
export const NO_EDIT_CARDS = {
    editCards: new Map(),
    consumedResults: new Set()
};
function toolPairOf(call, result) {
    return {
        name: call.name,
        input: call.input,
        ...call.state ? {
            state: call.state
        } : {},
        ...result ? {
            result: {
                output: result.output,
                isError: result.isError,
                editPatch: result.editPatch
            }
        } : {}
    };
}
export function buildEditCards(blocks) {
    const editCards = new Map();
    const consumedResults = new Set();
    for (const [index, pair] of pairToolBlocks(blocks).entries()){
        const call = pair.call;
        if (!call || !isEditToolName(call.name)) {
            continue;
        }
        const files = normalizedEditFiles(call, pair.result, ()=>editFilesFromToolPair(toolPairOf(call, pair.result)));
        if (!files || files.length === 0) {
            continue;
        }
        editCards.set(call, {
            files,
            key: `${call.name}:${index}`
        });
        if (pair.result) {
            consumedResults.add(pair.result);
        }
    }
    return {
        editCards,
        consumedResults
    };
}
// Counts-only files per call, shared by the diff rollup (buildDiffSummaries)
// and a turn's changed files (buildEditSummaries): for a call both read, the
// two derivations agree, so the patch is summarized once.
const editSummaries = new WeakMap();
function summaryEditFiles(call, result, derive) {
    const cached = editSummaries.get(call);
    if (cached && cached.result === result) {
        return cached.files;
    }
    const files = derive();
    editSummaries.set(call, {
        result,
        files
    });
    return files;
}
// Tessel: each edit call's files as a list of changed files shows them
// (editSummariesFromToolPair: counts and first changed line, no rows), plus
// detailed(): the full files (the expanded card's, cached with them), parsed
// only when asked for (the user opens a file's diff).
// -> Map call -> { files, detailed }
export function buildEditSummaries(blocks) {
    const summaries = new Map();
    for (const pair of pairToolBlocks(blocks)){
        const { call, result } = pair;
        if (!call || !isEditToolName(call.name)) {
            continue;
        }
        const detailed = ()=>normalizedEditFiles(call, result, ()=>editFilesFromToolPair(toolPairOf(call, result)));
        const files = summaryEditFiles(call, result, ()=>editSummariesFromToolPair(toolPairOf(call, result), detailed));
        if (files?.length) {
            summaries.set(call, {
                files,
                detailed
            });
        }
    }
    return summaries;
}
export function buildDiffSummaries(blocks) {
    const summaries = new Map();
    for (const [index, pair] of pairToolBlocks(blocks).entries()){
        const { call, result } = pair;
        if (!call || call.name !== 'Diff' || call.state === 'running' || call.state === 'failed' || result?.isError || result?.editPatch || !result?.output) {
            continue;
        }
        const input = call.input;
        if (!input || typeof input !== 'object' || !('path' in input) || typeof input.path !== 'string' || Object.keys(input).some((key)=>key !== 'path')) {
            continue;
        }
        const files = summaryEditFiles(call, result, ()=>editFilesFromPatchText(result.output, input.path, true));
        if (files?.length) {
            summaries.set(call, {
                files,
                key: `${call.name}:${index}`
            });
        }
    }
    return summaries;
}
