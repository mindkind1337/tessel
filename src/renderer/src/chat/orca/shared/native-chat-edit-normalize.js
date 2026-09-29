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
import { editFilesFromBeginPatch, unwrapBeginPatch } from "./native-chat-begin-patch.js";
import { editLinesFromContents } from "./native-chat-edit-lcs.js";
import { finalizeEditFile, pushEditGap } from "./native-chat-edit-model.js";
import { editFilesFromPatchText, splitMoveMarker } from "./native-chat-edit-patch-files.js";
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from "./native-chat-unified-patch.js";
const CLAUDE_EDIT_TOOLS = new Set([
    'Edit',
    'MultiEdit',
    'Write',
    'str_replace'
]);
const COMMAND_PATCH_TOOLS = new Set([
    'exec',
    'shell',
    'local_shell'
]);
const PATCH_ENVELOPE_TOOLS = new Set([
    'apply_patch',
    ...COMMAND_PATCH_TOOLS
]);
const PATCH_TEXT_TOOLS = new Set([
    'apply_patch',
    'Diff'
]);
export function isEditToolName(name) {
    return CLAUDE_EDIT_TOOLS.has(name) || PATCH_ENVELOPE_TOOLS.has(name) || PATCH_TEXT_TOOLS.has(name);
}
function record(value) {
    return typeof value === 'object' && value !== null ? value : null;
}
function text(value) {
    return typeof value === 'string' ? value : null;
}
function linesFromEditPatch(patch) {
    const lines = [];
    for (const hunk of patch.hunks){
        pushEditGap(lines);
        let oldNo = hunk.oldStart;
        let newNo = hunk.newStart;
        for (const raw of hunk.lines){
            if (raw.startsWith('+')) {
                lines.push({
                    kind: 'add',
                    text: raw.slice(1),
                    oldLineNumber: null,
                    newLineNumber: newNo
                });
                newNo += 1;
            } else if (raw.startsWith('-')) {
                lines.push({
                    kind: 'del',
                    text: raw.slice(1),
                    oldLineNumber: oldNo,
                    newLineNumber: null
                });
                oldNo += 1;
            } else {
                lines.push({
                    kind: 'context',
                    text: raw.startsWith(' ') ? raw.slice(1) : raw,
                    oldLineNumber: oldNo,
                    newLineNumber: newNo
                });
                oldNo += 1;
                newNo += 1;
            }
        }
    }
    return lines;
}
const CREATED_FILE_RESULT = /^\s*File created successfully/;
function wholeContentChangeKind(input, output) {
    if (text(input.command) === 'create') {
        return 'added';
    }
    return output !== undefined && CREATED_FILE_RESULT.test(output) ? 'added' : 'edited';
}
function multiEditFiles(input, path) {
    if (!Array.isArray(input.edits)) {
        return null;
    }
    const lines = [];
    let truncated = false;
    for (const entry of input.edits){
        const edit = record(entry);
        const oldString = text(edit?.old_string) ?? text(edit?.oldString);
        const newString = text(edit?.new_string) ?? text(edit?.newString);
        if (oldString === null && newString === null) {
            continue;
        }
        pushEditGap(lines);
        const diffed = editLinesFromContents(oldString ?? '', newString ?? '');
        lines.push(...diffed.lines);
        truncated ||= diffed.truncated;
    }
    if (lines.length === 0) {
        return null;
    }
    return [
        finalizeEditFile({
            path,
            oldPath: null,
            changeKind: 'edited',
            lines,
            lineNumbersKnown: false,
            truncated
        })
    ];
}
function claudeEditFiles(name, input, output) {
    const path = text(input.file_path) ?? text(input.path) ?? 'file';
    if (name === 'MultiEdit') {
        return multiEditFiles(input, path);
    }
    const oldString = text(input.old_string) ?? text(input.oldString);
    const newString = text(input.new_string) ?? text(input.newString);
    const content = text(input.content) ?? text(input.file_text);
    if (oldString === null && content !== null) {
        const whole = editLinesFromWholeFile(content, 'add');
        return [
            finalizeEditFile({
                path,
                oldPath: null,
                changeKind: wholeContentChangeKind(input, output),
                lines: whole.lines,
                lineNumbersKnown: true,
                truncated: whole.truncated
            })
        ];
    }
    if (oldString === null && newString === null) {
        return null;
    }
    const diffed = editLinesFromContents(oldString ?? '', newString ?? content ?? '');
    return [
        finalizeEditFile({
            path,
            oldPath: null,
            changeKind: 'edited',
            lines: diffed.lines,
            lineNumbersKnown: false,
            truncated: diffed.truncated
        })
    ];
}
function codexChangeFiles(changes) {
    return changes.flatMap((entry)=>{
        const change = record(entry);
        const path = text(change?.path);
        const diff = text(change?.diff);
        if (!change || !path || !diff) {
            return [];
        }
        const kind = record(change.kind);
        const kindType = text(kind?.type) ?? text(change.kind) ?? 'update';
        const movePath = text(kind?.move_path) ?? text(change.movePath);
        if (kindType === 'add' || kindType === 'delete') {
            const whole = editLinesFromWholeFile(diff, kindType === 'add' ? 'add' : 'del');
            return [
                finalizeEditFile({
                    path,
                    oldPath: null,
                    changeKind: kindType === 'add' ? 'added' : 'deleted',
                    lines: whole.lines,
                    lineNumbersKnown: true,
                    truncated: whole.truncated
                })
            ];
        }
        const parsed = editLinesFromUnifiedPatch(splitMoveMarker(diff).body);
        if (!parsed) {
            return [];
        }
        return [
            finalizeEditFile({
                path: movePath ?? path,
                oldPath: movePath ? path : null,
                changeKind: movePath ? 'renamed' : 'edited',
                lines: parsed.lines,
                lineNumbersKnown: parsed.lineNumbersKnown,
                truncated: parsed.truncated
            })
        ];
    });
}
export function editFilesFromToolPair(pair) {
    if (pair.state === 'failed' || pair.state === 'running' || pair.result?.isError === true) {
        return null;
    }
    if (pair.state !== 'completed' && pair.result === undefined) {
        return null;
    }
    const input = record(pair.input);
    const patch = pair.result?.editPatch;
    if (patch && patch.hunks.length > 0) {
        return [
            finalizeEditFile({
                path: patch.filePath ?? text(input?.file_path) ?? 'file',
                oldPath: null,
                changeKind: 'edited',
                lines: linesFromEditPatch(patch),
                lineNumbersKnown: true
            })
        ];
    }
    if (PATCH_ENVELOPE_TOOLS.has(pair.name)) {
        const envelope = unwrapBeginPatch(pair.input, {
            requireApplyCommand: COMMAND_PATCH_TOOLS.has(pair.name)
        });
        const files = envelope ? editFilesFromBeginPatch(envelope) : [];
        if (files.length > 0) {
            return files;
        }
    }
    if (input && Array.isArray(input.changes)) {
        const files = codexChangeFiles(input.changes);
        if (files.length > 0) {
            return files;
        }
    }
    if (input && CLAUDE_EDIT_TOOLS.has(pair.name)) {
        return claudeEditFiles(pair.name, input, pair.result?.output);
    }
    if (!PATCH_TEXT_TOOLS.has(pair.name)) {
        return null;
    }
    const patchText = text(input?.patch) ?? text(input?.diff) ?? (pair.name === 'Diff' ? pair.result?.output : null);
    if (!patchText) {
        return null;
    }
    return editFilesFromPatchText(patchText, text(input?.path) ?? text(input?.file_path));
}
