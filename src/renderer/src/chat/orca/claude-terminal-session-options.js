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
import { getAgentSessionOptionCatalog } from "./shared/agent-session-option-catalog.js";
import { stripScrollbackAnsi } from "./native-chat-scrape-fallback.js";
const EFFORT_ID_BY_LABEL = {
    low: 'low',
    medium: 'medium',
    high: 'high',
    'extra high': 'xhigh',
    xhigh: 'xhigh',
    max: 'max'
};
const CLAUDE_MODEL_EFFORT = /\bwith\s+(extra high|xhigh|medium|high|low|max)(?:\s+effort\b|\s*…|\s*$)/i;
const FRAME_TOP = '╭';
const FRAME_BOTTOM = '╰';
const FRAME_COLUMN = '│';
function normalizedScreenLines(screen) {
    return stripScrollbackAnsi(screen).split('\n').map((line)=>line.replace(/\s+/g, ' ').trim());
}
function isClaudeHeaderRow(line) {
    if (!/\bClaude Code/i.test(line)) {
        return false;
    }
    return /\bClaude Code\s*v?\d+(?:\.\d+){1,2}\b/i.test(line) || line.startsWith(FRAME_TOP);
}
function frameCell(line) {
    if (line.startsWith(FRAME_COLUMN)) {
        const afterBorder = line.slice(FRAME_COLUMN.length);
        const columnEnd = afterBorder.indexOf(FRAME_COLUMN);
        return (columnEnd === -1 ? afterBorder : afterBorder.slice(0, columnEnd)).trim();
    }
    return line.replace(/^[^A-Za-z0-9]+/, '').trim();
}
function isModelDescriptorCell(cell) {
    return cell.includes('·') || CLAUDE_MODEL_EFFORT.test(cell);
}
function isWorkingDirectoryCell(cell) {
    return cell.startsWith('/') || cell.startsWith('~') || /^[A-Za-z]:[\\/]/.test(cell) || /^\\\\[^\\]/.test(cell);
}
function claudeModelDescriptorCell(lines, headerIndex) {
    const frameBottom = lines.findIndex((line, index)=>index > headerIndex && line.startsWith(FRAME_BOTTOM));
    const lastRow = frameBottom > 0 ? frameBottom - 1 : Math.min(headerIndex + 2, lines.length - 1);
    for(let index = lastRow; index > headerIndex; index -= 1){
        const cell = frameCell(lines[index] ?? '');
        if (isModelDescriptorCell(cell)) {
            return cell;
        }
    }
    const joined = frameCell((lines[headerIndex] ?? '').replace(/^.*?\bClaude Code\s*v?[\d.]*/i, ''));
    if (isModelDescriptorCell(joined)) {
        return joined;
    }
    return frameBottom > 0 ? modelRowAboveWorkingDirectory(lines, headerIndex, frameBottom) : null;
}
function modelRowAboveWorkingDirectory(lines, headerIndex, frameBottom) {
    let workingDirectory = -1;
    for(let index = frameBottom - 1; index > headerIndex; index -= 1){
        const cell = frameCell(lines[index] ?? '');
        if (isWorkingDirectoryCell(cell)) {
            workingDirectory = index;
            break;
        }
    }
    if (workingDirectory < 0) {
        return null;
    }
    let top = workingDirectory;
    while(top - 1 > headerIndex && frameCell(lines[top - 1] ?? '')){
        top -= 1;
    }
    if (top >= workingDirectory || workingDirectory - top > 2) {
        return null;
    }
    const cell = frameCell(lines[top] ?? '');
    return /^API Usage Billing$/i.test(cell) ? null : cell;
}
function parseClaudeModelName(cell) {
    const beforeBilling = cell.split('·')[0];
    const effort = beforeBilling.match(CLAUDE_MODEL_EFFORT);
    const name = (effort?.index === undefined ? beforeBilling : beforeBilling.slice(0, effort.index)).trim();
    return name || null;
}
function modelNameTokens(value) {
    return value.toLowerCase().match(/[a-z]+|\d+[a-z]*/g) ?? [];
}
function labelNamesReportedModel(reportedModel, label) {
    const labelTokens = modelNameTokens(label);
    const family = labelTokens[0];
    if (!family) {
        return false;
    }
    const name = reportedModel.toLowerCase();
    if (name !== family && !name.startsWith(`${family} `)) {
        return false;
    }
    const nameTokens = modelNameTokens(name);
    let cursor = 1;
    for (const token of labelTokens.slice(1)){
        const found = nameTokens.indexOf(token, cursor);
        if (found === -1) {
            return false;
        }
        cursor = found + 1;
    }
    return true;
}
function findClaudeCatalogModel(reportedModel, models) {
    const seeded = getAgentSessionOptionCatalog('claude')?.models ?? [];
    for (const candidates of [
        models ?? [],
        seeded
    ]){
        const matches = candidates.filter(({ label })=>labelNamesReportedModel(reportedModel, label));
        const best = matches.sort((left, right)=>modelNameTokens(right.label).length - modelNameTokens(left.label).length)[0];
        if (best) {
            return best;
        }
    }
    return undefined;
}
export function readClaudeSessionOptionsFromTerminalScreen(screen, models) {
    if (!screen) {
        return null;
    }
    const lines = normalizedScreenLines(screen);
    const headerIndex = lines.findIndex(isClaudeHeaderRow);
    if (headerIndex === -1) {
        return null;
    }
    const descriptorCell = claudeModelDescriptorCell(lines, headerIndex);
    const reportedModel = descriptorCell ? parseClaudeModelName(descriptorCell) : null;
    if (!reportedModel) {
        return null;
    }
    const model = findClaudeCatalogModel(reportedModel, models);
    if (!model) {
        return {
            model: reportedModel
        };
    }
    const result = {
        model: model.id
    };
    const effortLabel = descriptorCell?.match(CLAUDE_MODEL_EFFORT)?.[1];
    const effort = effortLabel ? EFFORT_ID_BY_LABEL[effortLabel.toLowerCase()] : undefined;
    if (effort && model.options.some((option)=>option.id === 'effort')) {
        result.effort = effort;
    }
    return result;
}
