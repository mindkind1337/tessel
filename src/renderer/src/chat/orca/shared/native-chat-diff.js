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
export const EDIT_TOOL_NAMES = new Set([
    'Edit',
    'MultiEdit',
    'Write',
    'str_replace',
    'apply_patch'
]);
const MAX_DIFF_CHARS = 32_000;
const DEFAULT_MAX_DIFF_LINES = 120;
const DIFF_TRUNCATED_LINE = {
    kind: 'meta',
    text: '… diff truncated …'
};
const HUNK_HEADER = /^@@ -\d+(?:,\d+)? \+\d+(?:,\d+)? @@/;
export const FILE_SECTION_START = /^(?:diff |index |old mode |new mode |new file mode |deleted file mode |similarity index |dissimilarity index |rename |copy |Binary files )/;
const BARE_RULE = /^(?:-{3,}|\+{3,})$/;
export function isFileHeaderPair(lines, index) {
    return (lines[index] ?? '').startsWith('--- ') && (lines[index + 1] ?? '').startsWith('+++ ');
}
function scanDiffStructure(lines) {
    const metaIndices = new Set();
    let isStructuredDiff = false;
    let inHunk = false;
    for(let index = 0; index < lines.length; index += 1){
        const line = lines[index] ?? '';
        if (line.startsWith('@@')) {
            inHunk = true;
            isStructuredDiff ||= HUNK_HEADER.test(line);
            continue;
        }
        if (FILE_SECTION_START.test(line)) {
            inHunk = false;
            isStructuredDiff ||= line.startsWith('diff --git ');
            continue;
        }
        if (inHunk || !(line.startsWith('-') || line.startsWith('+'))) {
            continue;
        }
        if (BARE_RULE.test(line)) {
            metaIndices.add(index);
            continue;
        }
        if (isFileHeaderPair(lines, index)) {
            metaIndices.add(index);
            metaIndices.add(index + 1);
            index += 1;
        }
    }
    return {
        metaIndices,
        isStructuredDiff
    };
}
function toLines(value, maxLines) {
    if (typeof value !== 'string') {
        return {
            lines: [],
            truncated: false
        };
    }
    const clipped = value.slice(0, MAX_DIFF_CHARS);
    const lines = clipped.split('\n', maxLines + 1);
    const truncated = value.length > MAX_DIFF_CHARS || lines.length > maxLines;
    const bounded = lines.slice(0, maxLines);
    if (!truncated && bounded.at(-1) === '') {
        bounded.pop();
    }
    return {
        lines: bounded,
        truncated
    };
}
function patchTextFromToolInput(value) {
    if (typeof value.patch === 'string') {
        return value.patch;
    }
    if (typeof value.diff === 'string') {
        return value.diff;
    }
    if (!Array.isArray(value.changes)) {
        return null;
    }
    const sections = [];
    let length = 0;
    for (const entry of value.changes){
        if (typeof entry !== 'object' || entry === null) {
            continue;
        }
        const change = entry;
        if (typeof change.diff !== 'string') {
            continue;
        }
        const path = typeof change.path === 'string' ? change.path : 'file';
        const kind = typeof change.kind === 'object' && change.kind !== null ? change.kind : null;
        const nextPath = kind && typeof kind.move_path === 'string' ? kind.move_path : path;
        const section = `--- ${path}\n+++ ${nextPath}\n${change.diff}`;
        length += section.length + (sections.length > 0 ? 1 : 0);
        sections.push(section);
        if (length > MAX_DIFF_CHARS) {
            break;
        }
    }
    return sections.length > 0 ? sections.join('\n') : null;
}
export function diffFromToolCall(name, input, maxLines = DEFAULT_MAX_DIFF_LINES) {
    if (!EDIT_TOOL_NAMES.has(name) || typeof input !== 'object' || input === null) {
        return null;
    }
    const value = input;
    const patchText = patchTextFromToolInput(value);
    if (patchText !== null) {
        return diffFromText(patchText, maxLines);
    }
    const oldLines = toLines(value.old_string ?? value.oldString ?? value.old, maxLines);
    const newLines = toLines(value.new_string ?? value.newString ?? value.new ?? value.content ?? value.file_text, maxLines);
    const deleted = oldLines.lines.map((text)=>({
            kind: 'del',
            text
        }));
    const added = newLines.lines.map((text)=>({
            kind: 'add',
            text
        }));
    if (deleted.length === 0 && added.length === 0) {
        return null;
    }
    const path = value.file_path ?? value.path;
    const prefix = typeof path === 'string' ? [
        {
            kind: 'meta',
            text: path
        }
    ] : [];
    const combined = [
        ...prefix,
        ...deleted,
        ...added
    ];
    const truncated = oldLines.truncated || newLines.truncated || combined.length > maxLines;
    return truncated ? [
        ...combined.slice(0, maxLines - 1),
        DIFF_TRUNCATED_LINE
    ] : combined;
}
export function diffFromText(text, maxLines = DEFAULT_MAX_DIFF_LINES) {
    if (text.length === 0) {
        return null;
    }
    const bounded = toLines(text, maxLines);
    const { metaIndices, isStructuredDiff } = scanDiffStructure(bounded.lines);
    let added = 0;
    let removed = 0;
    const lines = bounded.lines.map((line, index)=>{
        if (metaIndices.has(index) || line.startsWith('@@') || line.startsWith('diff ') || line.startsWith('index ')) {
            return {
                kind: 'meta',
                text: line
            };
        }
        if (line.startsWith('+')) {
            added += 1;
            return {
                kind: 'add',
                text: line.slice(1)
            };
        }
        if (line.startsWith('-')) {
            removed += 1;
            return {
                kind: 'del',
                text: line.slice(1)
            };
        }
        return {
            kind: 'context',
            text: line
        };
    });
    if (added + removed < (isStructuredDiff ? 1 : 2)) {
        return null;
    }
    return bounded.truncated ? [
        ...lines.slice(0, maxLines - 1),
        DIFF_TRUNCATED_LINE
    ] : lines;
}
