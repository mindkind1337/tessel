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
import { isTerminalLinkActionActivation, isTerminalLinkDirectActivation } from '@/components/terminal-pane/terminal-link-activation';
import { buildHttpLinkActions, openRoutedHttpLink } from '@/lib/http-link-destinations';
export function handleNativeChatWebLink(event, url, deps) {
    const open = (destination)=>openRoutedHttpLink(url, {
            worktreeId: deps.worktreeId,
            sourceOwner: deps.sourceOwner,
            modifierHeld: false,
            ...destination ? {
                forceDestination: destination
            } : {}
        });
    if (isTerminalLinkDirectActivation(event)) {
        event.preventDefault();
        open(event.shiftKey ? deps.destinations.alternate ?? deps.destinations.primary : deps.destinations.primary);
        return true;
    }
    if (!isTerminalLinkActionActivation(event)) {
        return false;
    }
    if (!deps.actionsEnabled) {
        if (deps.plainClickBehavior === 'none') {
            return false;
        }
        event.preventDefault();
        open(deps.destinations.primary);
        return true;
    }
    event.preventDefault();
    const keyboardAnchor = event.detail === 0 ? event.currentTarget?.getBoundingClientRect() : null;
    deps.request({
        anchorX: keyboardAnchor?.left ?? event.clientX,
        anchorY: keyboardAnchor?.bottom ?? event.clientY,
        destination: url,
        kind: 'url',
        restoreFocus: deps.restoreFocus,
        ...buildHttpLinkActions(deps.destinations, open)
    });
    return true;
}
