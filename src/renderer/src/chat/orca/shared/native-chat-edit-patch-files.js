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
import { finalizeEditFile } from "./native-chat-edit-model.js";
import { stripBoundedTextMarker } from "./structured-agent-session-projection.js";
import { editLinesFromUnifiedPatch, summarizeUnifiedPatch, unifiedPatchSections } from "./native-chat-unified-patch.js";
const FILE_COUNT_PATH = /^\d+ files?$/;
const MOVE_MARKER = /(?:^|\n)Moved to: (.+)$/;
export function splitMoveMarker(patch) {
    const match = MOVE_MARKER.exec(patch);
    return match ? {
        body: patch.slice(0, match.index),
        movedTo: match[1].trim()
    } : {
        body: patch,
        movedTo: null
    };
}
export function editFilesFromPatchText(patchText, callerPath, summaryOnly = false) {
    if (callerPath !== null && FILE_COUNT_PATH.test(callerPath)) {
        return null;
    }
    const bounded = stripBoundedTextMarker(patchText);
    const moved = splitMoveMarker(bounded.text);
    const split = unifiedPatchSections(moved.body);
    const namedSections = split.sections.filter((section)=>section.path !== null).length;
    const named = (section)=>(namedSections <= 1 && section.oldPath === null ? callerPath ?? section.path : section.path ?? callerPath) ?? 'file';
    const files = split.sections.flatMap((section)=>{
        const parsed = summaryOnly ? summarizeUnifiedPatch(section.body) : editLinesFromUnifiedPatch(section.body);
        if (!parsed && section.path === null) {
            return [];
        }
        const metadata = {
            path: named(section),
            oldPath: section.oldPath,
            changeKind: section.changeKind,
            truncated: bounded.truncated || split.truncated || (parsed?.truncated ?? false)
        };
        return [
            summaryOnly ? {
                ...metadata,
                added: parsed && 'added' in parsed ? parsed.added : 0,
                removed: parsed && 'removed' in parsed ? parsed.removed : 0
            } : finalizeEditFile({
                ...metadata,
                lines: parsed && 'lines' in parsed ? parsed.lines : [],
                lineNumbersKnown: parsed && 'lineNumbersKnown' in parsed ? parsed.lineNumbersKnown : false
            })
        ];
    });
    if (moved.movedTo !== null && files.length === 1 && files[0]) {
        const only = files[0];
        return [
            {
                ...only,
                path: moved.movedTo,
                oldPath: only.path,
                changeKind: 'renamed'
            }
        ];
    }
    return files.length > 0 ? files : null;
}
