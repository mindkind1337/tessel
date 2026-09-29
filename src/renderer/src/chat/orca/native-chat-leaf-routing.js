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
function layoutNodeContainsLeaf(node, leafId) {
    if (!node) {
        return false;
    }
    if (node.type === 'leaf') {
        return node.leafId === leafId;
    }
    return layoutNodeContainsLeaf(node.first, leafId) || layoutNodeContainsLeaf(node.second, leafId);
}
export function resolveNativeChatActiveLayoutLeafId(layout) {
    if (!layout) {
        return null;
    }
    if (layout.activeLeafId) {
        return !layout.root || layoutNodeContainsLeaf(layout.root, layout.activeLeafId) ? layout.activeLeafId : null;
    }
    return layout.root?.type === 'leaf' ? layout.root.leafId : null;
}
export function isNativeChatTabWideFallbackSafe(layout) {
    if (!layout?.root) {
        return true;
    }
    if (layout.root.type === 'split') {
        return false;
    }
    return !layout.activeLeafId || layout.activeLeafId === layout.root.leafId;
}
export function nativeChatLeafOwnsTabWideEvidence(args) {
    const { ownerLeafId, leafId, leafIds } = args;
    if (!ownerLeafId || !leafId) {
        return false;
    }
    return leafIds.length === 1 && leafIds[0] === leafId && ownerLeafId === leafId;
}
export function nativeChatLaunchAgentForLeaf(args) {
    const { launchAgent, launchAgentLeafId, leafId, leafIds } = args;
    if (!launchAgent) {
        return null;
    }
    return nativeChatLeafOwnsTabWideEvidence({
        ownerLeafId: launchAgentLeafId,
        leafId,
        leafIds
    }) ? launchAgent : null;
}
export function resolveNativeChatLeafRoute(args) {
    const confirmedAgentExit = args.chatLeafHasConfirmedAgentExit;
    if (!args.isChatViewMode) {
        return {
            chatLeafId: null,
            exitChat: false
        };
    }
    if (args.chatLeafId && args.chatLeafStillMounted && !confirmedAgentExit) {
        return {
            chatLeafId: args.chatLeafId,
            exitChat: false
        };
    }
    if (!args.activeLeafId && !confirmedAgentExit) {
        return {
            chatLeafId: args.chatLeafId,
            exitChat: false
        };
    }
    if (args.chatLeafId && !args.chatLeafStillMounted && !confirmedAgentExit) {
        return {
            chatLeafId: null,
            exitChat: true
        };
    }
    if (args.activeLeafIsEligible && (!confirmedAgentExit || args.activeLeafId !== args.chatLeafId)) {
        return {
            chatLeafId: args.activeLeafId,
            exitChat: false
        };
    }
    return {
        chatLeafId: null,
        exitChat: true
    };
}
