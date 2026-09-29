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
import { hasWorkspaceFileDragType } from '@/lib/workspace-file-drag';
import { hasNativeFileDragTypes } from "./shared/native-file-drop.js";
export function nativeChatPaneDragKind(dataTransfer) {
    if (!dataTransfer) {
        return null;
    }
    if (hasWorkspaceFileDragType(dataTransfer)) {
        return 'workspace';
    }
    return hasNativeFileDragTypes(dataTransfer.types) ? 'os' : null;
}
export function movedWithinDropSurface(event) {
    const enteredNode = event.relatedTarget;
    return enteredNode instanceof Node && event.currentTarget.contains(enteredNode);
}
export function makeNativeChatPaneFileDropHandlers(host) {
    const showsDropTarget = (event)=>{
        const kind = nativeChatPaneDragKind(event.dataTransfer);
        if (kind === null) {
            return false;
        }
        const claim = host.getClaim();
        return claim !== null && !claim.disabled;
    };
    return {
        onDragEnterCapture (event) {
            if (showsDropTarget(event)) {
                host.setDragActive(true);
            }
        },
        onDragOverCapture (event) {
            if (showsDropTarget(event)) {
                host.setDragActive(true);
            }
            if (nativeChatPaneDragKind(event.dataTransfer) === 'workspace') {
                host.getClaim()?.onDragOverCapture(event);
            }
        },
        onDragLeaveCapture (event) {
            if (nativeChatPaneDragKind(event.dataTransfer) === null || movedWithinDropSurface(event)) {
                return;
            }
            host.setDragActive(false);
        },
        onDropCapture (event) {
            host.setDragActive(false);
            if (nativeChatPaneDragKind(event.dataTransfer) === 'workspace') {
                host.getClaim()?.onDropCapture(event);
            }
        }
    };
}
