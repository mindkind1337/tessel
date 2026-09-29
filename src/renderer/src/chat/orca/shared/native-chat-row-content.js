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
import { backgroundTaskBlocks, claimBackgroundTaskTwins } from "./native-chat-background-task-row.js";
import { isSubagentGroupFallbackText, subagentGroupBlocks } from "./native-chat-subagent-summary.js";
import { isBackgroundTaskBlock, isSubagentGroupBlock } from "./native-chat-types.js";
import { splitNativeChatBlocks } from "./native-chat-tool-fold.js";
import { nativeChatProseToMarkdown } from "./native-chat-prose.js";
const derivations = new WeakMap();
function derive(blocks) {
    const split = splitNativeChatBlocks(blocks);
    const groups = subagentGroupBlocks(split.prose);
    const tasks = backgroundTaskBlocks(split.prose);
    const taskTwins = claimBackgroundTaskTwins(split.prose);
    const prose = groups.length === 0 && tasks.length === 0 ? split.prose : split.prose.filter((block, index)=>!isSubagentGroupBlock(block) && !isBackgroundTaskBlock(block) && !taskTwins.twinTextIndexes.has(index) && !(groups.length > 0 && block.type === 'text' && isSubagentGroupFallbackText(block.text)));
    return {
        prose,
        tools: split.tools,
        subagentGroups: groups,
        backgroundTasks: tasks,
        markdown: nativeChatProseToMarkdown(prose),
        hasImages: prose.some((block)=>block.type === 'image-ref')
    };
}
export function deriveNativeChatRowContent(blocks) {
    const cached = derivations.get(blocks);
    if (cached) {
        return cached;
    }
    const content = derive(blocks);
    derivations.set(blocks, content);
    return content;
}
export function nativeChatRowRendersContent(blocks) {
    const { markdown, hasImages, tools, subagentGroups, backgroundTasks } = deriveNativeChatRowContent(blocks);
    return markdown.length > 0 || hasImages || tools.length > 0 || subagentGroups.length > 0 || backgroundTasks.length > 0;
}
