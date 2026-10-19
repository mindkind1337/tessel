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
export const MAX_EDIT_LINES = 2_000;
export const MAX_EDIT_CHARS = 96_000;
export const MAX_EDIT_DIFF_CELLS = 200_000;
export function splitEditContent(content) {
    if (content.length === 0) {
        return {
            lines: [],
            truncated: false
        };
    }
    const truncated = content.length > MAX_EDIT_CHARS;
    const body = truncated ? content.slice(0, MAX_EDIT_CHARS) : content;
    const lines = body.split(/\r?\n/);
    if (body.endsWith('\n')) {
        lines.pop();
    }
    return {
        lines,
        truncated
    };
}
function editGapLine() {
    return {
        kind: 'gap',
        text: '',
        oldLineNumber: null,
        newLineNumber: null
    };
}
export function pushEditGap(lines) {
    if (lines.length > 0 && lines.at(-1)?.kind !== 'gap') {
        lines.push(editGapLine());
    }
}
export function unifiedLineNumber(line) {
    return line.kind === 'del' ? line.oldLineNumber : line.newLineNumber ?? line.oldLineNumber;
}
// Tessel: the new-side line a file's first change sits at, fed row by row
// (kind, oldLineNumber, newLineNumber) so a patch summary finds it without
// building the rows. Same rule as chat/agentEdits.js firstChangedLine: an
// added row's own line, a removed row's line after the last context row of its
// hunk (else its old line).
export function createFirstChangeFinder() {
    let lastNew = null;
    let line;
    const positive = (n)=>Number.isSafeInteger(n) && n > 0 ? n : null;
    return {
        visit (kind, oldLineNumber, newLineNumber) {
            if (line !== undefined) {
                return;
            }
            if (kind === 'add') {
                line = positive(newLineNumber);
            } else if (kind === 'del') {
                line = lastNew !== null ? lastNew + 1 : positive(oldLineNumber);
            } else if (kind === 'context' && positive(newLineNumber)) {
                lastNew = newLineNumber;
            } else if (kind === 'gap') {
                lastNew = null;
            }
        },
        get line () {
            return line ?? null;
        }
    };
}
// Tessel: a finished edit file reduced to what a list of changed files shows
// (the patch summaries' shape: no rows, plus the first changed line).
export function summarizeEditFile(file) {
    const { lines, lineNumbersKnown, ...rest } = file;
    const finder = createFirstChangeFinder();
    if (lineNumbersKnown) {
        for (const row of lines){
            finder.visit(row.kind, row.oldLineNumber, row.newLineNumber);
        }
    }
    return {
        ...rest,
        firstLine: finder.line
    };
}
export function finalizeEditFile(input) {
    const overLineCap = input.lines.length > MAX_EDIT_LINES;
    const truncated = overLineCap || input.truncated === true;
    const capped = overLineCap ? input.lines.slice(0, MAX_EDIT_LINES) : input.lines;
    let end = capped.length;
    while(end > 0 && capped[end - 1]?.kind === 'gap'){
        end -= 1;
    }
    const trimmed = end === capped.length ? capped : capped.slice(0, end);
    const lines = input.lineNumbersKnown ? trimmed : trimmed.map((line)=>({
            ...line,
            oldLineNumber: null,
            newLineNumber: null
        }));
    let added = 0;
    let removed = 0;
    for (const line of lines){
        if (line.kind === 'add') {
            added += 1;
        } else if (line.kind === 'del') {
            removed += 1;
        }
    }
    return {
        ...input,
        lines,
        added,
        removed,
        truncated
    };
}
