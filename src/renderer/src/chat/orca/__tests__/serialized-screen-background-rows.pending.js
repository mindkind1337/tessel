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
import { describe, expect, it } from 'vitest';
import { Terminal } from '@xterm/headless';
import { SerializeAddon } from '@xterm/addon-serialize';
import { readClaudeSessionOptionsFromTerminalScreen } from "../claude-terminal-session-options.js";
import { agentInputLineCleared } from "../native-chat-launch-draft-send.js";
import { buildBoundedSessionTranscript } from '@/lib/agent-session-fork-context';
const CLAUDE_FRAME = [
    '╭─ Claude Code ───╮',
    '│Haiku 4.5│',
    '│API Usage Billing│',
    '│C:\\work\\repo│',
    '╰─────────────╯',
    '────────────────────────────────────────',
    '❯ ',
    '────────────────────────────────────────'
].join('\r\n');
async function serializedScreen(paintBackgroundBelow) {
    const terminal = new Terminal({
        cols: 40,
        rows: 14,
        allowProposedApi: true
    });
    const serializer = new SerializeAddon();
    terminal.loadAddon(serializer);
    const below = paintBackgroundBelow ? '\x1b[s\x1b[9;1H\x1b[48;5;236m\x1b[J\x1b[0m\x1b[u' : '';
    await new Promise((resolve)=>terminal.write(`\x1b[?1049h\x1b[H${CLAUDE_FRAME}\x1b[7;3H${below}`, resolve));
    const screen = serializer.serialize({
        scrollback: 0
    });
    terminal.dispose();
    return screen;
}
describe('text readers of a serialized screen with trailing background rows', ()=>{
    it('read the same model, prompt state and transcript as without them', async ()=>{
        const plain = await serializedScreen(false);
        const painted = await serializedScreen(true);
        expect(painted).toContain(`\r\n\x1b[48;5;236m\x1b[40X${'\r\n\x1b[40X'.repeat(5)}`);
        expect(readClaudeSessionOptionsFromTerminalScreen(painted)).toEqual({
            model: 'haiku'
        });
        expect(readClaudeSessionOptionsFromTerminalScreen(painted)).toEqual(readClaudeSessionOptionsFromTerminalScreen(plain));
        expect(agentInputLineCleared(painted)).toBe(true);
        expect(agentInputLineCleared(painted)).toBe(agentInputLineCleared(plain));
        expect(buildBoundedSessionTranscript(painted)).toBe(buildBoundedSessionTranscript(plain));
    });
});
