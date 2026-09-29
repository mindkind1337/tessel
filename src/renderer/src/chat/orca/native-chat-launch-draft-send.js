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
import { buildAgentTuiClearInputForText } from "./shared/agent-tui-input-clear.js";
import { stripScrollbackAnsi } from "./native-chat-scrape-fallback.js";
const COMPOSER_PROMPT_LINE = /^\s*([❯›])\s?(.*)$/;
const CLAUDE_FRAME_LINE = /^\s*─{3,}\s*$/;
const CODEX_FOOTER_LINE = /^\s*\S.*\s[·•]\s.*$/;
function composerContinuationIsEmpty(lines, promptIndex, glyph) {
    for(let index = promptIndex + 1; index < lines.length; index += 1){
        const line = lines[index];
        if (glyph === '❯' && CLAUDE_FRAME_LINE.test(line) || glyph === '›' && CODEX_FOOTER_LINE.test(line)) {
            return true;
        }
        if (line.trim() !== '') {
            return false;
        }
    }
    return true;
}
export function agentInputLineCleared(screen) {
    if (!screen) {
        return false;
    }
    const lines = stripScrollbackAnsi(screen).split('\n');
    for(let index = lines.length - 1; index >= 0; index -= 1){
        const match = COMPOSER_PROMPT_LINE.exec(lines[index]);
        if (match) {
            return match[2].trim() === '' && composerContinuationIsEmpty(lines, index, match[1]);
        }
    }
    return false;
}
export function planNativeChatLaunchDraftSend(args) {
    const seededText = args.seededText;
    if (!seededText || seededText.trim() === '') {
        return {
            kind: 'default'
        };
    }
    return {
        kind: 'replace-draft',
        clearInput: buildAgentTuiClearInputForText(seededText),
        seededText
    };
}
export function resolveNativeChatLaunchDraftSend(args) {
    const { launchDraft, launchDraftResolved, agent, readScreen } = args;
    const seededText = launchDraft && launchDraft.agent === agent && !launchDraftResolved ? launchDraft.text : null;
    const plan = planNativeChatLaunchDraftSend({
        seededText
    });
    if (plan.kind !== 'replace-draft') {
        return {
            plan,
            sendOptions: undefined
        };
    }
    return {
        plan,
        sendOptions: {
            clearInput: plan.clearInput,
            confirmCleared: ()=>agentInputLineCleared(readScreen())
        }
    };
}
