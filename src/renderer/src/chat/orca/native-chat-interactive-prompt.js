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
import { t } from "../../i18n/index.js";
import { buildAskAnswerKeys, buildCodexAskAnswerKeys, formatAskAnswer, hasAskAnswer, parseAskFromStatus, registerQuestionTool } from "./shared/native-chat-ask.js";
export { buildAskAnswerKeys, buildCodexAskAnswerKeys, formatAskAnswer, hasAskAnswer, parseAskFromStatus, registerQuestionTool };
const ESCAPE = String.fromCharCode(27);
export function parseApprovalFromStatus(interactivePrompt) {
    if (!interactivePrompt) {
        return null;
    }
    let parsed;
    try {
        parsed = JSON.parse(interactivePrompt);
    } catch  {
        return null;
    }
    if (!parsed || typeof parsed !== 'object') {
        return null;
    }
    const approval = parsed.approval;
    if (!approval || typeof approval !== 'object') {
        return null;
    }
    const tool = approval.tool;
    if (typeof tool !== 'string' || tool.length === 0) {
        return null;
    }
    const summary = approval.summary;
    return {
        title: t('chat.orca.approval.title', 'Allow {{value0}}?', {
            value0: tool
        }),
        detail: typeof summary === 'string' && summary.length > 0 ? summary : undefined,
        options: [
            {
                label: t('chat.orca.approval.allow', 'Allow'),
                send: '1'
            },
            {
                label: t('chat.orca.approval.deny', 'Deny'),
                send: ESCAPE
            }
        ]
    };
}
export function parseInteractivePrompt(interactivePrompt, toolName) {
    const prompt = parseAskFromStatus(interactivePrompt, toolName);
    if (prompt) {
        return {
            kind: 'question',
            prompt
        };
    }
    const approval = parseApprovalFromStatus(interactivePrompt);
    return approval ? {
        kind: 'approval',
        approval
    } : null;
}
