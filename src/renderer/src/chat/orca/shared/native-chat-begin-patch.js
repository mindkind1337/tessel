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
import { editLinesFromUnifiedPatch, editLinesFromWholeFile } from "./native-chat-unified-patch.js";
const BEGIN = '*** Begin Patch';
const END = '*** End Patch';
const FILE_HEADER = /^\*\*\* (Add|Update|Delete) File: (.+)$/;
const MOVE_HEADER = /^\*\*\* Move to: (.+)$/;
const CONTROL_LINE = /^\*\*\* (?:End of File|Environment ID:)/;
export function unwrapBeginPatch(input, options) {
    const source = envelopeSource(input, options?.requireApplyCommand === true);
    if (!source) {
        return null;
    }
    const start = source.indexOf(BEGIN);
    if (start === -1) {
        return null;
    }
    const end = source.indexOf(END, start);
    if (end === -1) {
        return null;
    }
    return source.slice(start, end + END.length);
}
const ENVELOPE_ARGUMENTS = [
    'input',
    'command',
    'patch',
    'arguments',
    'script'
];
const APPLY_COMMAND = /apply_?patch/;
function envelopeSource(input, requireApplyCommand) {
    if (typeof input === 'string') {
        const record = jsonRecord(input);
        return record ? envelopeArgument(record, requireApplyCommand) : applied(input, requireApplyCommand);
    }
    return typeof input === 'object' && input !== null ? envelopeArgument(input, requireApplyCommand) : null;
}
function applied(value, requireApplyCommand) {
    return !requireApplyCommand || APPLY_COMMAND.test(value) ? value : null;
}
function jsonRecord(value) {
    if (!value.trimStart().startsWith('{')) {
        return null;
    }
    try {
        const parsed = JSON.parse(value);
        return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed) ? parsed : null;
    } catch  {
        return null;
    }
}
function envelopeArgument(record, requireApplyCommand) {
    for (const key of ENVELOPE_ARGUMENTS){
        const value = record[key];
        const words = typeof value === 'string' ? [
            value
        ] : Array.isArray(value) ? value.filter((entry)=>typeof entry === 'string') : [];
        if (requireApplyCommand && !words.some((word)=>APPLY_COMMAND.test(word))) {
            continue;
        }
        const word = words.find((entry)=>entry.includes(BEGIN));
        if (word) {
            return word;
        }
    }
    return null;
}
export function editFilesFromBeginPatch(envelope) {
    const sections = [];
    const moves = new Map();
    for (const raw of envelope.split(/\r?\n/)){
        const header = FILE_HEADER.exec(raw);
        if (header) {
            sections.push({
                kind: header[1],
                path: header[2].trim(),
                body: []
            });
            continue;
        }
        const move = MOVE_HEADER.exec(raw);
        if (move && sections.length > 0) {
            moves.set(sections.length - 1, move[1].trim());
            continue;
        }
        if (raw === BEGIN || raw === END || CONTROL_LINE.test(raw) || sections.length === 0) {
            continue;
        }
        sections.at(-1).body.push(raw);
    }
    return sections.flatMap((section, index)=>{
        const body = section.body.join('\n');
        const moved = moves.get(index) ?? null;
        if (section.kind === 'Add' || section.kind === 'Delete') {
            const sign = section.kind === 'Add' ? '+' : '-';
            const stripped = section.body.map((line)=>line.startsWith(sign) ? line.slice(1) : line).join('\n');
            const whole = editLinesFromWholeFile(stripped, section.kind === 'Add' ? 'add' : 'del');
            return [
                finalizeEditFile({
                    path: section.path,
                    oldPath: null,
                    changeKind: section.kind === 'Add' ? 'added' : 'deleted',
                    lines: whole.lines,
                    lineNumbersKnown: true,
                    truncated: whole.truncated
                })
            ];
        }
        const parsed = editLinesFromUnifiedPatch(body, {
            implicitFirstHunk: true
        });
        return [
            finalizeEditFile({
                path: moved ?? section.path,
                oldPath: moved ? section.path : null,
                changeKind: moved ? 'renamed' : 'edited',
                lines: parsed?.lines ?? [],
                lineNumbersKnown: parsed?.lineNumbersKnown ?? false,
                truncated: parsed?.truncated ?? false
            })
        ];
    });
}
