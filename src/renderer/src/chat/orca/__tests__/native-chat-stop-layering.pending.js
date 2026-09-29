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
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
function source(path) {
    return readFileSync(join(process.cwd(), path), 'utf8');
}
describe('native chat layering', ()=>{
    it('keeps working chat at the pane layer below app notifications and floating surfaces', ()=>{
        const css = source('src/renderer/src/assets/main.css');
        for (const path of [
            'src/renderer/src/components/terminal-pane/TerminalOverlaySlot.tsx',
            'src/renderer/src/components/native-chat/StructuredAgentSessionPaneOverlayLayer.tsx'
        ]){
            expect(source(path)).toContain('<RetainedPaneHost');
        }
        expect(css).not.toMatch(/\.native-chat-pane-shell:has\(\[data-native-chat-working/);
        expect(css).toMatch(/\[data-sonner-toaster\][^{]*\{[^}]*z-index:\s*40\s*!important;/s);
    });
    it('publishes working state from both structured and bridge chat roots', ()=>{
        for (const path of [
            'src/renderer/src/components/native-chat/NativeChatStructuredSession.tsx',
            'src/renderer/src/components/native-chat/NativeChatResolvedView.tsx'
        ]){
            expect(source(path)).toContain('data-native-chat-working=');
        }
    });
    it('owns structured session panes at the retained worktree overlay layer', ()=>{
        const terminal = source('src/renderer/src/components/TerminalWorktreeSplitSurface.tsx');
        const tabGroup = source('src/renderer/src/components/tab-group/TabGroupPanel.tsx');
        expect(terminal).toContain('<StructuredAgentSessionPaneOverlayLayer');
        expect(tabGroup).not.toContain('<NativeChatView');
    });
});
