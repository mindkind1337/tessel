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
import { collapsedToolInputPrefix, unwrapLoginShellCommand, MAX_TOOL_PREVIEW_LENGTH } from "./native-chat-tool-preview-prefix.js";
import { isToolCallBlock } from "./native-chat-types.js";
const MAX_PREVIEW_STRING_INPUT = 160;
const MAX_PREVIEW_COLLECTION_ITEMS = 8;
const MAX_PREVIEW_DEPTH = 2;
const MAX_TOOL_RUN_SUMMARY_PARTS = 3;
const PRIMARY_ARG_KEYS = [
    'query',
    'pattern',
    'directory',
    'command',
    'cmd',
    'url',
    'description'
];
const BRIEF_ARG_KEYS = [
    'query',
    'pattern',
    'directory',
    'command',
    'cmd'
];
const COMMAND_ARG_KEYS = [
    'command',
    'cmd'
];
export const MAX_TOOL_DETAIL_LENGTH = 4000;
export function summarizeToolInput(input) {
    const collapsed = collapsedToolInputPrefix(unwrapLoginShellCommand(toRawPreview(input)));
    return collapsed.length <= MAX_TOOL_PREVIEW_LENGTH ? collapsed : `${collapsed.slice(0, MAX_TOOL_PREVIEW_LENGTH - 1)}…`;
}
export function createToolInputDisplay(input) {
    const normalized = normalizeToolInput(input);
    const filePath = normalizedToolFilePath(normalized);
    const label = describeNormalizedToolInput(normalized, filePath);
    return {
        label,
        filePath,
        hasDetail: normalizedToolInputHasDetail(normalized, label),
        formatDetail: ()=>truncateToolDetail(formatNormalizedToolInput(normalized))
    };
}
export function truncateToolDetail(text) {
    return text.length > MAX_TOOL_DETAIL_LENGTH ? `${text.slice(0, MAX_TOOL_DETAIL_LENGTH)}…` : text;
}
export function describeToolInput(input) {
    const normalized = normalizeToolInput(input);
    return describeNormalizedToolInput(normalized, normalizedToolFilePath(normalized));
}
function describeNormalizedToolInput(input, path) {
    if (path) {
        return summarizeToolPath(path);
    }
    if (input && typeof input === 'object') {
        const primary = firstPrimaryToolArg(input, PRIMARY_ARG_KEYS);
        if (primary) {
            return primary;
        }
    }
    return summarizeToolInput(input);
}
export function formatToolInput(input) {
    return formatNormalizedToolInput(normalizeToolInput(input));
}
function formatNormalizedToolInput(input) {
    if (input === null || input === undefined) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input === 'number' || typeof input === 'boolean') {
        return String(input);
    }
    try {
        return JSON.stringify(input, null, 2) ?? '';
    } catch  {
        return '';
    }
}
export function isStructuredToolInput(input) {
    return isStructuredNormalizedToolInput(normalizeToolInput(input));
}
function isStructuredNormalizedToolInput(input) {
    if (input === null || typeof input !== 'object') {
        return false;
    }
    return Array.isArray(input) ? input.length > 0 : Object.keys(input).length > 0;
}
function normalizedToolInputHasDetail(input, label) {
    if (isStructuredNormalizedToolInput(input)) {
        return true;
    }
    return typeof input === 'string' && collapsedToolInputPrefix(input) !== label;
}
export function toolFilePath(input) {
    return normalizedToolFilePath(normalizeToolInput(input));
}
function normalizedToolFilePath(input) {
    if (!input || typeof input !== 'object') {
        return null;
    }
    const value = input;
    const directory = isSearchToolInput(value) ? undefined : value.path;
    const path = value.file_path ?? value.filePath ?? directory ?? value.notebook_path ?? firstPatchChangePath(value);
    return typeof path === 'string' && path.length > 0 ? path : null;
}
function firstPatchChangePath(value) {
    if (!Array.isArray(value.changes)) {
        return undefined;
    }
    for (const change of value.changes){
        if (typeof change === 'object' && change !== null && typeof change.path === 'string') {
            return change.path;
        }
    }
    return undefined;
}
export function briefToolArg(input) {
    const normalized = normalizeToolInput(input);
    if (normalized && typeof normalized === 'object') {
        const path = toolFilePath(normalized);
        if (path) {
            const parts = path.split(/[\\/]/).filter(Boolean);
            return parts.at(-1) ?? path;
        }
        const value = normalized;
        const command = firstPrimaryToolArg(value, BRIEF_ARG_KEYS);
        if (command) {
            return command.slice(0, 28);
        }
        if (BRIEF_ARG_KEYS.some((key)=>typeof value[key] === 'string')) {
            return '';
        }
    }
    return summarizeToolInput(normalized).slice(0, 28);
}
export function toolInputCommand(input) {
    const normalized = normalizeToolInput(input);
    return isToolInputRecord(normalized) ? firstPrimaryToolArg(normalized, COMMAND_ARG_KEYS) : null;
}
function isToolInputRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function normalizeToolInput(input) {
    if (typeof input !== 'string') {
        return input;
    }
    const first = input.trimStart()[0];
    if (first !== '{' && first !== '[') {
        return input;
    }
    try {
        const parsed = JSON.parse(input);
        return parsed !== null && typeof parsed === 'object' ? parsed : input;
    } catch  {
        return input;
    }
}
function isSearchToolInput(value) {
    return summarizePrimaryToolArg(value.query) !== null || summarizePrimaryToolArg(value.pattern) !== null;
}
function firstPrimaryToolArg(value, keys) {
    for (const key of keys){
        const summary = summarizePrimaryToolArg(value[key]);
        if (summary) {
            return summary;
        }
    }
    return null;
}
function summarizeToolPath(path) {
    const collapsed = path.replace(/\s+/g, ' ').trim();
    if (collapsed.length <= MAX_TOOL_PREVIEW_LENGTH) {
        return collapsed;
    }
    const tail = collapsed.slice(collapsed.length - (MAX_TOOL_PREVIEW_LENGTH - 1));
    const boundary = tail.search(/[\\/]/);
    return `…${boundary > 0 ? tail.slice(boundary) : tail}`;
}
function summarizePrimaryToolArg(input) {
    if (typeof input === 'string' && input.trim()) {
        return summarizeToolInput(input);
    }
    if (Array.isArray(input) && input.length > 0 && input.every((part)=>typeof part === 'string')) {
        return summarizeToolInput(input.join(' '));
    }
    return null;
}
export function toolRunSummaryMembers(blocks) {
    const members = [];
    for (const block of blocks){
        if (!isToolCallBlock(block)) {
            continue;
        }
        const name = block.name.trim();
        if (!name) {
            continue;
        }
        members.push({
            name,
            arg: briefToolArg(block.input),
            mcpIdentity: block.mcpIdentity
        });
        if (members.length >= MAX_TOOL_RUN_SUMMARY_PARTS) {
            break;
        }
    }
    return members;
}
export function summarizeToolRun(blocks) {
    return toolRunSummaryMembers(blocks).map((member)=>member.arg ? `${member.name} ${member.arg}` : member.name).join('  ·  ');
}
export function countToolCalls(blocks) {
    let count = 0;
    blocks.forEach((block)=>{
        if (isToolCallBlock(block)) {
            count += 1;
        }
    });
    return count;
}
function toRawPreview(input) {
    if (input === null || input === undefined) {
        return '';
    }
    if (typeof input === 'string') {
        return input;
    }
    if (typeof input !== 'object') {
        return String(input);
    }
    try {
        return JSON.stringify(boundedPreviewValue(input, 0, new WeakSet())) ?? '';
    } catch  {
        return '';
    }
}
function boundedPreviewValue(value, depth, seen) {
    if (typeof value === 'string') {
        return value.length > MAX_PREVIEW_STRING_INPUT ? `${value.slice(0, MAX_PREVIEW_STRING_INPUT)}…` : value;
    }
    if (!value || typeof value !== 'object') {
        return value;
    }
    if (seen.has(value)) {
        return '[circular]';
    }
    if (depth >= MAX_PREVIEW_DEPTH) {
        return '[…]';
    }
    seen.add(value);
    if (Array.isArray(value)) {
        const result = value.slice(0, MAX_PREVIEW_COLLECTION_ITEMS).map((item)=>boundedPreviewValue(item, depth + 1, seen));
        if (value.length > MAX_PREVIEW_COLLECTION_ITEMS) {
            result.push('…');
        }
        return result;
    }
    const result = {};
    let count = 0;
    for(const key in value){
        if (!Object.hasOwn(value, key)) {
            continue;
        }
        if (count >= MAX_PREVIEW_COLLECTION_ITEMS) {
            result['…'] = '…';
            break;
        }
        result[key] = boundedPreviewValue(value[key], depth + 1, seen);
        count += 1;
    }
    return result;
}
