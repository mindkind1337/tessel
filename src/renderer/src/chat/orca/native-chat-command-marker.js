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
import { setBoundedScopeCacheEntry } from "./native-chat-composer-scope-cache.js";
const COMMAND_MARKER_LIMIT = 8;
const commandMarkerCache = new Map();
let commandMarkerCounter = 0;
function commandMarkerScopeKey(scope) {
    return `${scope.paneKey}\0${scope.agent}\0${scope.sessionId ?? ''}`;
}
export function readCommandMarkerCache(scope) {
    return [
        ...commandMarkerCache.get(commandMarkerScopeKey(scope)) ?? []
    ];
}
export function appendCommandMarkerCache(scope, command, sentAt = Date.now()) {
    commandMarkerCounter += 1;
    const key = commandMarkerScopeKey(scope);
    const next = [
        ...commandMarkerCache.get(key) ?? [],
        {
            id: `${sentAt}-${commandMarkerCounter}`,
            command,
            sentAt
        }
    ].slice(-COMMAND_MARKER_LIMIT);
    setBoundedScopeCacheEntry(commandMarkerCache, key, next);
    return [
        ...next
    ];
}
export function clearCommandMarkerCacheForTests() {
    commandMarkerCache.clear();
    commandMarkerCounter = 0;
}
function isClearCommand(command) {
    return command.trim().toLowerCase().split(/\s+/)[0] === '/clear';
}
function latestClearSentAt(markers) {
    let latest = null;
    for (const marker of markers){
        if (isClearCommand(marker.command) && (latest === null || marker.sentAt > latest)) {
            latest = marker.sentAt;
        }
    }
    return latest;
}
export function applyCommandMarkerBoundaries(messages, markers) {
    const clearSentAt = latestClearSentAt(markers);
    if (clearSentAt === null) {
        return messages;
    }
    return messages.filter((message)=>message.timestamp !== null && message.timestamp > clearSentAt);
}
export function commandMarkersAsMessages(markers) {
    return markers.map((marker)=>({
            id: `command:${marker.id}`, // i18n-ignore
            role: 'system',
            blocks: [
                {
                    type: 'text',
                    text: t("chat.orca.copy.ran_command", "Ran {{command}}", { command: marker.command })
                }
            ],
            timestamp: marker.sentAt,
            source: 'scrape'
        }));
}
export function isCommandMarkerId(id) {
    return id.startsWith('command:');
}
