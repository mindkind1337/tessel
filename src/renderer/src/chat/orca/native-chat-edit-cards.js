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
import { editFilesFromToolPair, isEditToolName } from "./shared/native-chat-edit-normalize.js";
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
export function buildEditCards(blocks) {
    const editCards = new Map();
    const consumedResults = new Set();
    for (const [index, pair] of pairToolBlocks(blocks).entries()){
        const call = pair.call;
        if (!call || !isEditToolName(call.name)) {
            continue;
        }
        const files = normalizedEditFiles(call, pair.result, ()=>editFilesFromToolPair({
                name: call.name,
                input: call.input,
                ...call.state ? {
                    state: call.state
                } : {},
                ...pair.result ? {
                    result: {
                        output: pair.result.output,
                        isError: pair.result.isError,
                        editPatch: pair.result.editPatch
                    }
                } : {}
            }));
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
const diffSummaries = new WeakMap();
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
        const cached = diffSummaries.get(call);
        let files = cached?.result === result ? cached.files : undefined;
        if (files === undefined) {
            files = editFilesFromPatchText(result.output, input.path, true);
            diffSummaries.set(call, {
                result,
                files
            });
        }
        if (files?.length) {
            summaries.set(call, {
                files,
                key: `${call.name}:${index}`
            });
        }
    }
    return summaries;
}
