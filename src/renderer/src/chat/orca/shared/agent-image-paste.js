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
import { imagePasteWritesFollowedByText, separateImagePasteFromFollowingText } from "./image-paste-following-text.js";
import { isWindowsAbsolutePathLike } from "./cross-platform-path.js";
import { filesystemPathToFileUri } from "./file-uri-path.js";
const IMAGE_ATTACHMENT_AGENTS = new Set([
    'claude',
    'openclaude',
    'codex',
    'gemini',
    'cursor',
    'copilot',
    'droid',
    'grok'
]);
export function getAgentImageHandling(agent) {
    return agent && IMAGE_ATTACHMENT_AGENTS.has(agent) ? 'attachment' : 'unsupported';
}
export function formatNativeChatFileReference(filePath) {
    if (!/[\s@]/.test(filePath)) {
        return `@${filePath}`;
    }
    if (!filePath.includes('"')) {
        return `@"${filePath}"`;
    }
    if (!filePath.includes("'")) {
        return `@'${filePath}'`;
    }
    const escaped = filePath.replace(/"/g, '\\"');
    return `@"${escaped}"`;
}
export function formatAgentImagePath(agent, filePath) {
    if (agent === 'omp' && /[\s@]/.test(filePath) && filePath.includes('"') && filePath.includes("'") && (filePath.startsWith('/') || isWindowsAbsolutePathLike(filePath))) {
        return `@"${filesystemPathToFileUri(filePath)}"`;
    }
    return getAgentImageHandling(agent) === 'attachment' ? filePath : formatNativeChatFileReference(filePath);
}
export function agentImagePasteWrites(agent, framedPastes, followedByText) {
    if (getAgentImageHandling(agent) === 'attachment') {
        return imagePasteWritesFollowedByText(framedPastes, followedByText);
    }
    return framedPastes.map((paste, index)=>separateImagePasteFromFollowingText(paste, index < framedPastes.length - 1 || followedByText));
}
