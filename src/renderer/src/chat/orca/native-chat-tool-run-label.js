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
import { joinNativeChatToolRunClauses, nativeChatToolRunClauses } from "./shared/native-chat-tool-run-sentence.js";
import { isToolCallBlock } from "./shared/native-chat-types.js";
import { toolInputCommand } from "./shared/native-chat-tool-summary.js";
function clause(category, count, live) {
    const one = count === 1;
    const value0 = {
        value0: count
    };
    if (live) {
        return liveClause(category, one, value0);
    }
    switch(category){
        case 'read':
            return one ? t('chat.orca.tool.runReadOne', 'Read 1 file') : t('chat.orca.tool.runReadMany', 'Read {{value0}} files', value0);
        case 'search':
            return one ? t('chat.orca.tool.runSearchOne', 'Searched 1 time') : t('chat.orca.tool.runSearchMany', 'Searched {{value0}} times', value0);
        case 'listFiles':
            return one ? t('chat.orca.tool.runListFilesOne', 'Listed 1 directory') : t('chat.orca.tool.runListFilesMany', 'Listed {{value0}} directories', value0);
        case 'unknown':
            return one ? t('chat.orca.tool.runCommandOne', 'Ran 1 command') : t('chat.orca.tool.runCommandMany', 'Ran {{value0}} commands', value0);
        case 'fileChange':
            return one ? t('chat.orca.tool.runFileChangeOne', 'Edited 1 file') : t('chat.orca.tool.runFileChangeMany', 'Edited {{value0}} files', value0);
        case 'webSearch':
            return one ? t('chat.orca.tool.runWebSearchOne', 'Searched the web 1 time') : t('chat.orca.tool.runWebSearchMany', 'Searched the web {{value0}} times', value0);
        case 'mcpToolCall':
            return one ? t('chat.orca.tool.runIntegrationOne', 'Used 1 integration') : t('chat.orca.tool.runIntegrationMany', 'Used {{value0}} integrations', value0);
        case 'subAgentActivity':
            return one ? t('chat.orca.tool.runAgentOne', 'Ran 1 agent') : t('chat.orca.tool.runAgentMany', 'Ran {{value0}} agents', value0);
        case 'todoList':
            return one ? t('chat.orca.tool.runPlanOne', 'Updated the plan') : t('chat.orca.tool.runPlanMany', 'Updated the plan {{value0}} times', value0);
        case 'other':
            return one ? t('chat.orca.tool.runToolOne', 'Used 1 tool') : t('chat.orca.tool.runToolMany', 'Used {{value0}} tools', value0);
    }
}
function liveClause(category, one, value0) {
    switch(category){
        case 'read':
            return one ? t('chat.orca.tool.runLiveReadOne', 'Reading 1 file') : t('chat.orca.tool.runLiveReadMany', 'Reading {{value0}} files', value0);
        case 'search':
            return one ? t('chat.orca.tool.runLiveSearchOne', 'Searching 1 time') : t('chat.orca.tool.runLiveSearchMany', 'Searching {{value0}} times', value0);
        case 'listFiles':
            return one ? t('chat.orca.tool.runLiveListFilesOne', 'Listing 1 directory') : t('chat.orca.tool.runLiveListFilesMany', 'Listing {{value0}} directories', value0);
        case 'unknown':
            return one ? t('chat.orca.tool.runLiveCommandOne', 'Running 1 command') : t('chat.orca.tool.runLiveCommandMany', 'Running {{value0}} commands', value0);
        case 'fileChange':
            return one ? t('chat.orca.tool.runLiveFileChangeOne', 'Editing 1 file') : t('chat.orca.tool.runLiveFileChangeMany', 'Editing {{value0}} files', value0);
        case 'webSearch':
            return one ? t('chat.orca.tool.runLiveWebSearchOne', 'Searching the web 1 time') : t('chat.orca.tool.runLiveWebSearchMany', 'Searching the web {{value0}} times', value0);
        case 'mcpToolCall':
            return one ? t('chat.orca.tool.runLiveIntegrationOne', 'Using 1 integration') : t('chat.orca.tool.runLiveIntegrationMany', 'Using {{value0}} integrations', value0);
        case 'subAgentActivity':
            return one ? t('chat.orca.tool.runLiveAgentOne', 'Running 1 agent') : t('chat.orca.tool.runLiveAgentMany', 'Running {{value0}} agents', value0);
        case 'todoList':
            return one ? t('chat.orca.tool.runLivePlanOne', 'Updating the plan') : t('chat.orca.tool.runLivePlanMany', 'Updating the plan {{value0}} times', value0);
        case 'other':
            return one ? t('chat.orca.tool.runLiveToolOne', 'Using 1 tool') : t('chat.orca.tool.runLiveToolMany', 'Using {{value0}} tools', value0);
    }
}
export function nativeChatToolRunSentence(blocks, { live = false } = {}) {
    const calls = blocks.filter(isToolCallBlock);
    if (calls.length === 0) {
        return null;
    }
    if (calls.length === 1 && !live) {
        const command = toolInputCommand(calls[0].input);
        if (command !== null && command.length > 0) {
            return command;
        }
    }
    return joinNativeChatToolRunClauses(nativeChatToolRunClauses(calls).map(({ category, count })=>clause(category, count, live)), {
        pair: (first, second)=>t('chat.orca.tool.runPair', '{{value0}} and {{value1}}', {
                value0: first,
                value1: second
            }),
        list: (leading, last)=>t('chat.orca.tool.runList', '{{value0}}, and {{value1}}', {
                value0: leading,
                value1: last
            })
    });
}
