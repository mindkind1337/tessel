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
import { buildDiffSummaries } from "./native-chat-edit-cards.js";
export function nativeChatTurnDiffs(messages, turnKeys) {
    const turns = new Map();
    for (const [index, message] of messages.entries()){
        const turnKey = turnKeys[index];
        if (!turnKey) {
            continue;
        }
        for (const edit of buildDiffSummaries(message.blocks).values()){
            let files = turns.get(turnKey);
            if (!files) {
                files = new Map();
                turns.set(turnKey, files);
            }
            for (const [fileIndex, file] of edit.files.entries()){
                const previous = files.get(file.path);
                const renamed = file.oldPath && file.oldPath !== file.path ? files.get(file.oldPath) : undefined;
                if (renamed) {
                    files.delete(renamed.path);
                }
                files.set(file.path, {
                    path: file.path,
                    added: file.added + (previous?.added ?? 0) + (renamed?.added ?? 0),
                    removed: file.removed + (previous?.removed ?? 0) + (renamed?.removed ?? 0),
                    truncated: file.truncated || (previous?.truncated ?? false) || (renamed?.truncated ?? false),
                    target: {
                        messageId: message.id,
                        editKey: edit.key,
                        fileIndex
                    }
                });
            }
        }
    }
    return new Map(Array.from(turns, ([key, byPath])=>{
        const files = Array.from(byPath.values());
        return [
            key,
            {
                files,
                added: files.reduce((sum, file)=>sum + file.added, 0),
                removed: files.reduce((sum, file)=>sum + file.removed, 0),
                truncated: files.some((file)=>file.truncated)
            }
        ];
    }));
}
