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
import { FILE_SECTION_START, isFileHeaderPair } from "./native-chat-diff.js";
import { MAX_EDIT_LINES, splitEditContent } from "./native-chat-edit-model.js";
const HUNK_RANGES = /^@@+ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
export function editLinesFromUnifiedPatch(text, options) {
    const lines = [];
    const metadata = visitUnifiedPatch(text, (kind, raw, oldLineNumber, newLineNumber)=>{
        lines.push({
            kind,
            text: raw,
            oldLineNumber,
            newLineNumber
        });
    }, options);
    return metadata ? {
        lines,
        ...metadata
    } : null;
}
export function summarizeUnifiedPatch(text) {
    let added = 0;
    let removed = 0;
    let rowCount = 0;
    const metadata = visitUnifiedPatch(text, (kind)=>{
        rowCount += 1;
        if (rowCount <= MAX_EDIT_LINES) {
            added += Number(kind === 'add');
            removed += Number(kind === 'del');
        }
    });
    return metadata ? {
        added,
        removed,
        truncated: metadata.truncated || rowCount > MAX_EDIT_LINES
    } : null;
}
function visitUnifiedPatch(text, visit, options) {
    const source = splitEditContent(text);
    const rows = source.lines;
    let rowCount = 0;
    let lastWasGap = false;
    let oldNo = null;
    let newNo = null;
    let sawHunk = options?.implicitFirstHunk === true;
    let ranged = true;
    let inHunk = sawHunk;
    for(let index = 0; index < rows.length; index += 1){
        const raw = rows[index] ?? '';
        if (raw.startsWith('@@')) {
            const match = HUNK_RANGES.exec(raw);
            oldNo = match ? Number(match[1]) : null;
            newNo = match ? Number(match[3]) : null;
            if (rowCount > 0 && !lastWasGap) {
                visit('gap', '', null, null);
                rowCount += 1;
                lastWasGap = true;
            }
            sawHunk = true;
            inHunk = true;
            continue;
        }
        if (raw.startsWith('\\')) {
            continue;
        }
        if (!inHunk && isFileHeaderPair(rows, index)) {
            index += 1;
            continue;
        }
        if (FILE_SECTION_START.test(raw)) {
            inHunk = false;
            continue;
        }
        if (!inHunk) {
            continue;
        }
        ranged &&= oldNo !== null || newNo !== null;
        rowCount += 1;
        lastWasGap = false;
        if (raw.startsWith('+')) {
            visit('add', raw.slice(1), null, newNo);
            newNo = newNo === null ? null : newNo + 1;
        } else if (raw.startsWith('-')) {
            visit('del', raw.slice(1), oldNo, null);
            oldNo = oldNo === null ? null : oldNo + 1;
        } else {
            visit('context', raw.startsWith(' ') ? raw.slice(1) : raw, oldNo, newNo);
            oldNo = oldNo === null ? null : oldNo + 1;
            newNo = newNo === null ? null : newNo + 1;
        }
    }
    return sawHunk && rowCount > 0 ? {
        lineNumbersKnown: ranged,
        truncated: source.truncated
    } : null;
}
const GIT_DIFF_HEADER = 'diff --git ';
export function unifiedPatchSections(text) {
    const source = splitEditContent(text);
    const rows = source.lines;
    const sections = [];
    let current = null;
    let inHunk = false;
    const open = ()=>{
        const section = {
            rows: [],
            oldPath: null,
            newPath: null,
            named: false,
            hasHeaderPair: false,
            fromGitHeader: false
        };
        sections.push(section);
        return section;
    };
    for(let index = 0; index < rows.length; index += 1){
        const raw = rows[index] ?? '';
        if (raw.startsWith(GIT_DIFF_HEADER)) {
            const paths = gitHeaderPaths(raw);
            current = open();
            current.oldPath = paths.oldPath;
            current.newPath = paths.newPath;
            current.named = true;
            current.fromGitHeader = true;
            inHunk = false;
            continue;
        }
        if (isFileHeaderPair(rows, index) && (!inHunk || (rows[index + 2] ?? '').startsWith('@@'))) {
            if (!current || current.hasHeaderPair) {
                current = open();
            }
            current.oldPath = sourceHeaderPath(rows[index] ?? '');
            current.newPath = sourceHeaderPath(rows[index + 1] ?? '');
            current.named = true;
            current.hasHeaderPair = true;
            inHunk = false;
            index += 1;
            continue;
        }
        if (raw.startsWith('@@')) {
            inHunk = true;
        } else if (FILE_SECTION_START.test(raw)) {
            inHunk = false;
        }
        current ??= open();
        current.rows.push(raw);
    }
    return {
        sections: sections.map((section)=>({
                path: section.newPath ?? section.oldPath,
                oldPath: sectionChangeKind(section) === 'renamed' ? section.oldPath : null,
                changeKind: sectionChangeKind(section),
                body: section.rows.join('\n')
            })),
        truncated: source.truncated
    };
}
function sectionChangeKind(section) {
    if (!section.named) {
        return 'edited';
    }
    if (section.newPath === null) {
        return 'deleted';
    }
    if (section.oldPath === null) {
        return 'added';
    }
    if (section.oldPath === section.newPath) {
        return 'edited';
    }
    return section.fromGitHeader ? 'renamed' : 'edited';
}
function sourceHeaderPath(line) {
    const value = (line.slice(4).split('\t')[0] ?? '').trim();
    return value === '' || value === '/dev/null' ? null : value.replace(/^[ab]\//, '');
}
function gitHeaderPaths(line) {
    const rest = line.slice(GIT_DIFF_HEADER.length);
    const split = rest.lastIndexOf(' b/');
    if (split === -1) {
        return {
            oldPath: null,
            newPath: null
        };
    }
    return {
        oldPath: rest.slice(0, split).replace(/^a\//, ''),
        newPath: rest.slice(split + 1).replace(/^b\//, '')
    };
}
export function editLinesFromWholeFile(content, kind) {
    const body = splitEditContent(content);
    return {
        lines: body.lines.map((text, index)=>({
                kind,
                text,
                oldLineNumber: kind === 'del' ? index + 1 : null,
                newLineNumber: kind === 'add' ? index + 1 : null
            })),
        truncated: body.truncated
    };
}
