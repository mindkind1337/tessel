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
import { getAgentSlashCommands } from "./native-chat-slash-commands.js";
const NATIVE_CHAT_AGENT_PROFILES = {
    codex: {
        skillPrefix: '$',
        skillSourceOwner: 'codex',
        textDrivenCommands: [
            'goal'
        ]
    },
    claude: {
        skillPrefix: '/',
        skillSourceOwner: 'claude',
        expandsSlashCommandsFromText: true
    },
    openclaude: {
        skillPrefix: '/',
        skillSourceOwner: 'claude',
        expandsSlashCommandsFromText: true
    },
    grok: {
        skillPrefix: '/',
        skillSourceOwner: 'grok'
    }
};
export function getNativeChatAgentProfile(agent) {
    return agent ? NATIVE_CHAT_AGENT_PROFILES[agent] ?? null : null;
}
export function getVerifiedNativeChatCommands(agent) {
    return agent === 'grok' ? [] : getAgentSlashCommands(agent);
}
export function getTextDrivenNativeChatCommands(agent) {
    if (!agent) {
        return [];
    }
    const names = new Set(getNativeChatAgentProfile(agent)?.textDrivenCommands ?? []);
    return names.size === 0 ? [] : getVerifiedNativeChatCommands(agent).filter((command)=>names.has(command.name));
}
export function getHostClaimedNativeChatCommands(agent) {
    const profile = getNativeChatAgentProfile(agent);
    if (profile?.expandsSlashCommandsFromText) {
        return [];
    }
    const passedThrough = new Set(profile?.textDrivenCommands ?? []);
    return getVerifiedNativeChatCommands(agent).filter((command)=>!passedThrough.has(command.name));
}
