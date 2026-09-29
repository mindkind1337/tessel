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
import { buildAgentNotificationId } from "../agent-notification-id.js";
describe('buildAgentNotificationId', ()=>{
    it('builds a stable id for the same agent event metadata', ()=>{
        const args = {
            worktreeId: 'repo::/Users/me/orca/workspaces/feature',
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            stateStartedAt: 1780000000123
        };
        expect(buildAgentNotificationId(args)).toBe(buildAgentNotificationId(args));
    });
    it('changes when the agent state start time changes', ()=>{
        const base = {
            worktreeId: 'repo::/Users/me/orca/workspaces/feature',
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
        };
        expect(buildAgentNotificationId({
            ...base,
            stateStartedAt: 1780000000123
        })).not.toBe(buildAgentNotificationId({
            ...base,
            stateStartedAt: 1780000000456
        }));
    });
    it('returns null when required fields are missing', ()=>{
        expect(buildAgentNotificationId({
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111',
            stateStartedAt: 1780000000123
        })).toBeNull();
        expect(buildAgentNotificationId({
            worktreeId: 'repo::/Users/me/orca/workspaces/feature',
            stateStartedAt: 1780000000123
        })).toBeNull();
        expect(buildAgentNotificationId({
            worktreeId: 'repo::/Users/me/orca/workspaces/feature',
            paneKey: 'tab-1:11111111-1111-4111-8111-111111111111'
        })).toBeNull();
    });
});
