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
import { t } from "../../../i18n/index.js";
const COMMON_COMMANDS = [
    {
        name: 'clear',
        get description() { return t("chat.orca.copy.clear_the_conversation", "Clear the conversation"); }
    },
    {
        name: 'help',
        get description() { return t("chat.orca.copy.show_available_commands", "Show available commands"); }
    }
];
const CLAUDE_COMMANDS = [
    {
        name: 'clear',
        get description() { return t("chat.orca.copy.clear_conversation_history", "Clear conversation history"); }
    },
    {
        name: 'compact',
        get description() { return t("chat.orca.copy.summarize_and_compact_the_conversation", "Summarize and compact the conversation"); }
    },
    {
        name: 'init',
        get description() { return t("chat.orca.copy.initialize_a_claude_md", "Initialize a CLAUDE.md"); }
    },
    {
        name: 'review',
        get description() { return t("chat.orca.copy.review_the_current_changes", "Review the current changes"); }
    },
    {
        name: 'help',
        get description() { return t("chat.orca.copy.show_available_commands", "Show available commands"); }
    }
];
const CODEX_COMMANDS = [
    {
        name: 'model',
        get description() { return t("chat.orca.copy.choose_the_model_and_reasoning_effort", "Choose the model and reasoning effort"); }
    },
    {
        name: 'ide',
        get description() { return t("chat.orca.copy.include_ide_context", "Include IDE context"); }
    },
    {
        name: 'permissions',
        get description() { return t("chat.orca.copy.choose_what_codex_is_allowed_to_do", "Choose what Codex is allowed to do"); }
    },
    {
        name: 'keymap',
        get description() { return t("chat.orca.copy.remap_tui_shortcuts", "Remap TUI shortcuts"); }
    },
    {
        name: 'vim',
        get description() { return t("chat.orca.copy.toggle_vim_mode", "Toggle Vim mode"); }
    },
    {
        name: 'experimental',
        get description() { return t("chat.orca.copy.toggle_experimental_features", "Toggle experimental features"); }
    },
    {
        name: 'approve',
        get description() { return t("chat.orca.copy.approve_one_auto_review_retry", "Approve one auto-review retry"); }
    },
    {
        name: 'memories',
        get description() { return t("chat.orca.copy.configure_memory_use", "Configure memory use"); }
    },
    {
        name: 'skills',
        get description() { return t("chat.orca.copy.manage_and_use_skills", "Manage and use skills"); }
    },
    {
        name: 'import',
        get description() { return t("chat.orca.copy.import_setup_from_claude_code", "Import setup from Claude Code"); }
    },
    {
        name: 'hooks',
        get description() { return t("chat.orca.copy.view_lifecycle_hooks", "View lifecycle hooks"); }
    },
    {
        name: 'review',
        get description() { return t("chat.orca.copy.review_the_current_changes", "Review the current changes"); }
    },
    {
        name: 'rename',
        get description() { return t("chat.orca.copy.rename_the_current_thread", "Rename the current thread"); }
    },
    {
        name: 'new',
        get description() { return t("chat.orca.copy.start_a_new_chat", "Start a new chat"); }
    },
    {
        name: 'archive',
        get description() { return t("chat.orca.copy.archive_this_session_and_exit", "Archive this session and exit"); }
    },
    {
        name: 'delete',
        get description() { return t("chat.orca.copy.delete_this_session_and_exit", "Delete this session and exit"); }
    },
    {
        name: 'resume',
        get description() { return t("chat.orca.copy.resume_a_saved_chat", "Resume a saved chat"); }
    },
    {
        name: 'fork',
        get description() { return t("chat.orca.copy.fork_the_current_chat", "Fork the current chat"); }
    },
    {
        name: 'app',
        get description() { return t("chat.orca.copy.continue_in_codex_desktop", "Continue in Codex Desktop"); }
    },
    {
        name: 'init',
        get description() { return t("chat.orca.copy.create_an_agents_md_file", "Create an AGENTS.md file"); }
    },
    {
        name: 'compact',
        get description() { return t("chat.orca.copy.compact_the_conversation", "Compact the conversation"); }
    },
    {
        name: 'plan',
        get description() { return t("chat.orca.copy.switch_to_plan_mode", "Switch to Plan mode"); }
    },
    {
        name: 'goal',
        get description() { return t("chat.orca.copy.set_or_view_the_goal", "Set or view the goal"); }
    },
    {
        name: 'agent',
        get description() { return t("chat.orca.copy.switch_the_active_agent_thread", "Switch the active agent thread"); }
    },
    {
        name: 'side',
        get description() { return t("chat.orca.copy.start_a_side_conversation", "Start a side conversation"); }
    },
    {
        name: 'copy',
        get description() { return t("chat.orca.copy.copy_the_last_response_as_markdown", "Copy the last response as markdown"); }
    },
    {
        name: 'raw',
        get description() { return t("chat.orca.copy.toggle_raw_scrollback_mode", "Toggle raw scrollback mode"); }
    },
    {
        name: 'diff',
        get description() { return t("chat.orca.copy.show_the_working_diff", "Show the working diff"); }
    },
    {
        name: 'mention',
        get description() { return t("chat.orca.copy.mention_a_file", "Mention a file"); }
    },
    {
        name: 'status',
        get description() { return t("chat.orca.copy.show_session_configuration_and_usage", "Show session configuration and usage"); }
    },
    {
        name: 'usage',
        get description() { return t("chat.orca.copy.view_account_usage", "View account usage"); }
    },
    {
        name: 'title',
        get description() { return t("chat.orca.copy.configure_the_terminal_title", "Configure the terminal title"); }
    },
    {
        name: 'statusline',
        get description() { return t("chat.orca.copy.configure_the_status_line", "Configure the status line"); }
    },
    {
        name: 'theme',
        get description() { return t("chat.orca.copy.choose_a_syntax_highlighting_theme", "Choose a syntax highlighting theme"); }
    },
    {
        name: 'pets',
        get description() { return t("chat.orca.copy.choose_or_hide_the_terminal_pet", "Choose or hide the terminal pet"); }
    },
    {
        name: 'mcp',
        get description() { return t("chat.orca.copy.list_configured_mcp_tools", "List configured MCP tools"); }
    },
    {
        name: 'plugins',
        get description() { return t("chat.orca.copy.browse_plugins", "Browse plugins"); }
    },
    {
        name: 'logout',
        get description() { return t("chat.orca.copy.log_out_of_codex", "Log out of Codex"); }
    },
    {
        name: 'exit',
        get description() { return t("chat.orca.copy.exit_codex", "Exit Codex"); }
    },
    {
        name: 'feedback',
        get description() { return t("chat.orca.copy.send_logs_to_maintainers", "Send logs to maintainers"); }
    },
    {
        name: 'ps',
        get description() { return t("chat.orca.copy.list_background_terminals", "List background terminals"); }
    },
    {
        name: 'stop',
        get description() { return t("chat.orca.copy.stop_all_background_terminals", "Stop all background terminals"); }
    },
    {
        name: 'clear',
        get description() { return t("chat.orca.copy.clear_the_terminal_and_start_a_new_chat", "Clear the terminal and start a new chat"); }
    },
    {
        name: 'personality',
        get description() { return t("chat.orca.copy.choose_a_communication_style", "Choose a communication style"); }
    },
    {
        name: 'subagents',
        get description() { return t("chat.orca.copy.switch_the_active_agent_thread", "Switch the active agent thread"); }
    }
];
const OMP_COMMANDS = [
    {
        name: 'model',
        get description() { return t("chat.orca.copy.open_the_model_selector_in_terminal", "Open the model selector in Terminal"); }
    },
    {
        name: 'switch',
        get description() { return t("chat.orca.copy.open_the_temporary_model_selector_in_terminal", "Open the temporary model selector in Terminal"); }
    },
    {
        name: 'plan',
        get description() { return t("chat.orca.copy.toggle_plan_mode", "Toggle plan mode"); }
    },
    {
        name: 'compact',
        get description() { return t("chat.orca.copy.compact_conversation_context", "Compact conversation context"); }
    },
    {
        name: 'clear',
        get description() { return t("chat.orca.copy.clear_context_while_keeping_the_session", "Clear context while keeping the session"); }
    },
    {
        name: 'new',
        get description() { return t("chat.orca.copy.start_a_new_session", "Start a new session"); }
    },
    {
        name: 'resume',
        get description() { return t("chat.orca.copy.resume_a_session_without_arguments_choose_in_terminal", "Resume a session; without arguments, choose in Terminal"); }
    },
    {
        name: 'fork',
        get description() { return t("chat.orca.copy.fork_from_a_previous_message_in_terminal", "Fork from a previous message in Terminal"); }
    },
    {
        name: 'branch',
        get description() { return t("chat.orca.copy.rewind_to_a_previous_message_in_terminal", "Rewind to a previous message in Terminal"); }
    },
    {
        name: 'tree',
        get description() { return t("chat.orca.copy.browse_the_session_tree_in_terminal", "Browse the session tree in Terminal"); }
    },
    {
        name: 'session',
        get description() { return t("chat.orca.copy.show_session_information_and_controls", "Show session information and controls"); }
    },
    {
        name: 'rename',
        get description() { return t("chat.orca.copy.rename_the_session", "Rename the session"); }
    },
    {
        name: 'context',
        get description() { return t("chat.orca.copy.show_estimated_context_usage", "Show estimated context usage"); }
    },
    {
        name: 'usage',
        get description() { return t("chat.orca.copy.show_provider_usage_and_limits", "Show provider usage and limits"); }
    },
    {
        name: 'fast',
        get description() { return t("chat.orca.copy.toggle_priority_service_tier", "Toggle priority service tier"); }
    },
    {
        name: 'tools',
        get description() { return t("chat.orca.copy.show_tools_visible_to_the_agent", "Show tools visible to the agent"); }
    },
    {
        name: 'jobs',
        get description() { return t("chat.orca.copy.show_background_jobs", "Show background jobs"); }
    },
    {
        name: 'git',
        get description() { return t("chat.orca.copy.open_the_git_viewer_in_terminal", "Open the Git viewer in Terminal"); }
    },
    {
        name: 'export',
        get description() { return t("chat.orca.copy.export_the_session_to_html", "Export the session to HTML"); }
    },
    {
        name: 'settings',
        get description() { return t("chat.orca.copy.open_settings_in_terminal", "Open settings in Terminal"); }
    },
    {
        name: 'extensions',
        get description() { return t("chat.orca.copy.open_the_extension_dashboard_in_terminal", "Open the extension dashboard in Terminal"); }
    },
    {
        name: 'hotkeys',
        get description() { return t("chat.orca.copy.show_keyboard_shortcuts_in_terminal", "Show keyboard shortcuts in Terminal"); }
    }
];
const COMMANDS_BY_AGENT = {
    claude: CLAUDE_COMMANDS,
    openclaude: CLAUDE_COMMANDS,
    codex: CODEX_COMMANDS,
    omp: OMP_COMMANDS
};
export function getAgentSlashCommands(agent) {
    return COMMANDS_BY_AGENT[agent] ?? COMMON_COMMANDS;
}
export function sessionSlashCommandSuggestions(agent, reported) {
    const described = new Map(getAgentSlashCommands(agent).map((command)=>[
            command.name,
            command.description
        ]));
    return reported.filter((entry)=>entry.kind === 'command').map((entry)=>{
        const description = entry.description ?? described.get(entry.name);
        return {
            name: entry.name,
            ...description ? {
                description
            } : {},
            ...entry.argumentHint ? {
                argumentHint: entry.argumentHint
            } : {},
            ...entry.kindUnspecified ? {
                kindUnspecified: true
            } : {}
        };
    });
}
export function sessionReportedSkillNames(reported) {
    return reported.filter((entry)=>entry.kind === 'skill').map((entry)=>entry.name);
}
export function isSlashCommandDraft(draft) {
    return draft.trimStart().startsWith('/');
}
export function filterSlashCommands(commands, query) {
    const normalized = query.toLowerCase();
    if (normalized === '') {
        return [
            ...commands
        ];
    }
    return commands.filter((command)=>command.name.toLowerCase().startsWith(normalized));
}
export function applySlashSuggestion(command) {
    return `/${command.name} `;
}
export function slashCommandDispatchText(command) {
    return `/${command.name}`;
}
export function classifyNativeChatSend(draft, commands, pickerSkillOriginToken, skillPrefix) {
    const firstToken = draft.split(/\s/, 1)[0] ?? '';
    if (pickerSkillOriginToken && firstToken === pickerSkillOriginToken) {
        return 'chat';
    }
    if (commands.some((command)=>firstToken === `/${command.name}`)) {
        return 'command';
    }
    if (firstToken.startsWith('/')) {
        return 'unknown-token';
    }
    if (skillPrefix === '$' && firstToken.startsWith('$')) {
        return 'unknown-token';
    }
    return 'chat';
}
