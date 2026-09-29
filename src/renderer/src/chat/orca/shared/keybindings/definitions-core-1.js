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
import { t } from "../../../../i18n/index.js";
import { platformBindings } from "./definitions-support.js";
export const KEYBINDING_DEFINITION_CORE_1 = [
    {
        id: 'worktree.quickOpen',
        get title() { return t("chat.orca.copy.go_to_file", "Go to File"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'file',
            'quick open'
        ],
        defaultBindings: platformBindings([
            'Mod+P'
        ])
    },
    {
        id: 'app.settings',
        get title() { return t("chat.orca.copy.open_settings", "Open Settings"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'settings',
            'preferences'
        ],
        defaultBindings: platformBindings([]),
        conflictGroup: 'menu'
    },
    {
        id: 'app.forceReload',
        get title() { return t("chat.orca.copy.force_reload", "Force Reload"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'reload',
            'refresh',
            'force'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+R'
        ]),
        conflictGroup: 'menu'
    },
    {
        id: 'worktree.palette',
        get title() { return t("chat.orca.copy.switch_worktree", "Switch worktree"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'worktree',
            'switch',
            'jump'
        ],
        defaultBindings: {
            darwin: [
                'Mod+J'
            ],
            linux: [
                'Mod+Shift+J'
            ],
            win32: [
                'Mod+Shift+J'
            ]
        }
    },
    {
        id: 'worktree.navigateUp',
        get title() { return t("chat.orca.copy.previous_worktree", "Previous worktree"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'worktree',
            'previous',
            'up'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+ArrowUp'
        ])
    },
    {
        id: 'worktree.navigateDown',
        get title() { return t("chat.orca.copy.next_worktree", "Next worktree"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'worktree',
            'next',
            'down'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+ArrowDown'
        ])
    },
    {
        id: 'workspace.create',
        get title() { return t("chat.orca.copy.create_worktree", "Create worktree"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'worktree',
            'create',
            'new workspace'
        ],
        defaultBindings: platformBindings([
            'Mod+N',
            'Mod+Shift+N'
        ])
    },
    {
        id: 'workspace.rename',
        get title() { return t("chat.orca.copy.rename_worktree", "Rename worktree"); },
        group: 'Global',
        scope: 'global',
        conflictGroup: 'workspace-shell',
        searchKeywords: [
            'shortcut',
            'global',
            'worktree',
            'rename',
            'workspace',
            'title'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Alt+R'
            ],
            linux: [],
            win32: []
        }
    },
    {
        id: 'workspace.delete',
        get title() { return t("chat.orca.copy.delete_workspace", "Delete Workspace"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'workspace',
            'current workspace',
            'worktree',
            'delete',
            'remove',
            'trash'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+Backspace'
        ]),
        allowInTerminal: true
    },
    {
        id: 'workspace.openBoard',
        get title() { return t("chat.orca.copy.toggle_workspace_board", "Toggle Workspace Board"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'workspace',
            'board',
            'kanban',
            'worktree',
            'toggle',
            'open',
            'close'
        ],
        defaultBindings: platformBindings([]),
        allowInTerminal: true
    },
    {
        id: 'dashboard.toggle',
        get title() { return t("chat.orca.copy.toggle_agent_dashboard", "Toggle Agent Dashboard"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'agent',
            'agents',
            'dashboard',
            'kanban',
            'board',
            'toggle',
            'open',
            'close'
        ],
        defaultBindings: platformBindings([]),
        allowInTerminal: true
    },
    {
        id: 'workspace.selectByIndex',
        get title() { return t("chat.orca.copy.select_workspace_1_9", "Select Workspace 1–9"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'global',
            'workspace',
            'worktree',
            'select',
            'switch',
            'number',
            'digit',
            '1-9',
            'index'
        ],
        defaultBindings: platformBindings([
            'Mod+1'
        ])
    },
    {
        id: 'voice.dictation',
        get title() { return t("chat.orca.copy.dictation", "Dictation"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'dictation',
            'voice',
            'speech',
            'microphone'
        ],
        defaultBindings: platformBindings([
            'Mod+E'
        ])
    },
    {
        id: 'view.tasks',
        get title() { return t("chat.orca.copy.open_tasks", "Open Tasks"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'tasks',
            'github issues',
            'linear'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'sidebar.left.toggle',
        get title() { return t("chat.orca.copy.toggle_sidebar", "Toggle Sidebar"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'left'
        ],
        defaultBindings: platformBindings([
            'Mod+B'
        ])
    },
    {
        id: 'sidebar.right.toggle',
        get title() { return t("chat.orca.copy.toggle_right_sidebar", "Toggle Right Sidebar"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'right'
        ],
        defaultBindings: platformBindings([
            'Mod+L'
        ])
    },
    {
        id: 'sidebar.explorer.toggle',
        get title() { return t("chat.orca.copy.show_explorer", "Show Explorer"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'explorer',
            'files'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+E'
        ])
    },
    {
        id: 'sidebar.search.toggle',
        get title() { return t("chat.orca.copy.show_search", "Show Search"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'search'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+F'
        ])
    },
    {
        id: 'sidebar.sourceControl.toggle',
        get title() { return t("chat.orca.copy.show_source_control", "Show Source Control"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'source control',
            'git'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+G'
        ])
    },
    {
        id: 'sidebar.checks.toggle',
        get title() { return t("chat.orca.copy.show_checks", "Show Checks"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'checks',
            'ci'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'sidebar.ports.toggle',
        get title() { return t("chat.orca.copy.show_ports", "Show Ports"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'ports'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Shift+I'
            ],
            linux: [],
            win32: []
        }
    },
    {
        id: 'sidebar.sleepingWorkspaces.toggle',
        get title() { return t("chat.orca.copy.toggle_sleeping_workspaces", "Toggle Sleeping Workspaces"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'sleeping',
            'asleep',
            'workspaces',
            'worktree',
            'filter',
            'show',
            'hide'
        ],
        defaultBindings: platformBindings([])
    },
    {
        id: 'sidebar.focusWorktreeList',
        get title() { return t("chat.orca.copy.focus_worktree_list", "Focus worktree list"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'sidebar',
            'worktree',
            'focus'
        ],
        defaultBindings: platformBindings([
            'Mod+Shift+0'
        ])
    },
    {
        id: 'floatingTerminal.toggle',
        get title() { return t("chat.orca.copy.toggle_floating_terminal", "Toggle Floating Terminal"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'floating terminal',
            'terminal'
        ],
        defaultBindings: platformBindings([
            'Mod+Alt+A'
        ]),
        allowInTerminal: true
    },
    {
        id: 'floatingWorkspace.maximize',
        get title() { return t("chat.orca.copy.maximize_floating_workspace_panel", "Maximize Floating Workspace Panel"); },
        group: 'Global',
        scope: 'global',
        searchKeywords: [
            'shortcut',
            'floating',
            'workspace',
            'panel',
            'floating workspace',
            'workspace panel',
            'maximize',
            'expand'
        ],
        defaultBindings: {
            darwin: [
                'Mod+Alt+Shift+A'
            ],
            linux: [],
            win32: []
        },
        allowInTerminal: true
    }
];
