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
import { createClaudeCatalogOptions, getAgentSessionOptionCatalog } from "./shared/agent-session-option-catalog.js";
import { getCommitMessageModelDiscoveryHostKeyForLocalRuntime, getCommitMessageModelDiscoveryHostKeyForScope, LOCAL_COMMIT_MESSAGE_HOST_KEY } from "./shared/commit-message-host-key.js";
import { getSettingsForAgentTabRuntimeOwner } from '@/lib/agent-paste-draft';
import { getConnectionIdFromState } from '@/lib/connection-context';
import { getLocalProjectExecutionRuntimeContext, getWslDistroFromPath } from '@/lib/local-preflight-context';
import { discoverRuntimeCommitMessageModels, getRuntimeGitScope } from '@/runtime/runtime-git-client';
import { callStructuredAgentSession } from '@/runtime/structured-agent-session-client';
import { useAppStore } from '@/store';
export function resolveNativeChatModelDiscoveryHostKey(state, worktreeId, worktreePath, scope) {
    if (scope !== null) {
        return getCommitMessageModelDiscoveryHostKeyForScope(scope);
    }
    const localProjectRuntime = getLocalProjectExecutionRuntimeContext(state, worktreeId);
    const wslDistro = localProjectRuntime?.status === 'resolved' && localProjectRuntime.runtime.kind === 'wsl' ? localProjectRuntime.runtime.distro : getWslDistroFromPath(worktreePath);
    return getCommitMessageModelDiscoveryHostKeyForLocalRuntime(wslDistro);
}
export function resolveNativeChatModelDiscoveryContext(terminalTabId) {
    const state = useAppStore.getState();
    const worktreeId = Object.entries(state.tabsByWorktree ?? {}).find(([, tabs])=>tabs.some((tab)=>tab.id === terminalTabId))?.[0] ?? null;
    const connectionId = getConnectionIdFromState(state, worktreeId);
    if (worktreeId && connectionId === undefined) {
        return null;
    }
    const settings = getSettingsForAgentTabRuntimeOwner(terminalTabId);
    const worktreePath = worktreeId ? state.getKnownWorktreeById?.(worktreeId)?.path ?? '' : '';
    const scope = getRuntimeGitScope(settings, connectionId);
    return {
        hostKey: resolveNativeChatModelDiscoveryHostKey(state, worktreeId, worktreePath, scope),
        runtime: {
            settings,
            worktreeId,
            worktreePath,
            ...connectionId ? {
                connectionId
            } : {}
        }
    };
}
function catalogModelsFromHostCatalog(agent, models) {
    return models.map((model)=>({
            id: model.id,
            label: model.label,
            ...model.description ? {
                description: model.description
            } : {},
            ...model.isDefault ? {
                isDefault: true
            } : {},
            options: agent === 'claude' ? createClaudeCatalogOptions({
                effortLevelIds: model.efforts.map((effort)=>effort.value),
                ...model.supportsFastMode !== undefined ? {
                    supportsFastMode: model.supportsFastMode
                } : {}
            }) : []
        }));
}
async function readLocalHostCatalogModels(agent) {
    try {
        const result = await callStructuredAgentSession({
            kind: 'local'
        }, 'agentSession.modelCatalog', {
            agent
        });
        if (result.origin === 'unknown' || result.models.length === 0) {
            return null;
        }
        return catalogModelsFromHostCatalog(agent, result.models);
    } catch  {
        return null;
    }
}
export async function discoverNativeChatCatalogModels(agent, context, hostKey) {
    const hostCatalogAgent = agent === 'claude' ? 'claude' : agent === 'codex' ? 'codex' : null;
    if (hostCatalogAgent && hostKey === LOCAL_COMMIT_MESSAGE_HOST_KEY) {
        const fromHost = await readLocalHostCatalogModels(hostCatalogAgent);
        if (fromHost) {
            return fromHost;
        }
    }
    const result = await discoverRuntimeCommitMessageModels(context, agent);
    const catalog = getAgentSessionOptionCatalog(agent);
    if (!result.success || result.models.length === 0 || (agent === 'claude' || catalog?.discoveredModelsAreAuthoritative) && result.catalogOrigin !== 'probe') {
        return null;
    }
    return result.models.map((model)=>({
            id: model.id,
            label: model.label,
            ...model.description ? {
                description: model.description
            } : {},
            ...model.isDefault ? {
                isDefault: true
            } : {},
            options: agent === 'claude' ? createClaudeCatalogOptions({
                effortLevelIds: model.thinkingLevels?.map(({ id })=>id) ?? [],
                supportsFastMode: model.supportsFastMode
            }) : []
        }));
}
