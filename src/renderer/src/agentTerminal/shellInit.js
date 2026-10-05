// The first line typed in an agent's own terminal (agentTerminalTargets.js):
// the variables VS Code sets for its agent terminals, agent commands kept out
// of the shell's saved history (they start with a space), and a small shell
// integration so Tessel knows where each command starts and ends, with its
// exit code (OSC 633 A, B, C, D, E, P;Cwd, P;HasRichCommandDetection). Then
// the screen is cleared.
//
// A minimal version of Visual Studio Code's shell integration scripts.
// Copyright (c) Microsoft Corporation. Licensed under the MIT License
// (https://github.com/microsoft/vscode/blob/main/LICENSE.txt):
// src/vs/workbench/contrib/terminal/common/scripts/shellIntegration.ps1 and
// shellIntegration-bash.sh, -rc.zsh; the environment from
// src/vs/workbench/contrib/terminalContrib/chatAgentTools/browser/
// toolTerminalCreator.ts.

export const AGENT_ENV = {
  AI_AGENT: 'tessel',
  GIT_PAGER: 'cat',
  PAGER: 'cat',
  GIT_EDITOR: ':',
  GIT_MERGE_AUTOEDIT: 'no',
  DEBIAN_FRONTEND: 'noninteractive'
}

// PowerShell (Windows PowerShell 5.1 and 7). One line.
export function pwshInit(env = AGENT_ENV) {
  const vars = Object.entries(env)
    .map(([k, v]) => `$env:${k}='${String(v).replace(/'/g, "''")}'`) // i18n-ignore
    .join('; ')
  const state = '$Global:__ts=@{P=$function:prompt;H=-1;N=$true;X=$false}'
  // A value as the sequences carry it: ; \ and control characters as \xAB.
  const esc = "function Global:__ts_esc([string]$v){ [regex]::Replace($v, '[\\x00-\\x1f\\\\;]', { param($m) '\\x{0:x2}' -f [int][char]$m.Value }) }"
  // The prompt: D (with the exit code when a command ran: VS Code's
  // history-id test), A, the folder, the original prompt, B.
  const prompt = [
    'function Global:prompt(){ $c=[int]!$global:?; $h=Get-History -Count 1; $e=[char]27; $b=[char]7; $r=""; ',
    'if($Global:__ts.H -ne -1 -and ($Global:__ts.N -or $Global:__ts.X)){ $Global:__ts.X=$false; ',
    'if($h -and $h.Id -eq $Global:__ts.H){ $r+="$e]633;D$b" } else { $r+="$e]633;D;$c$b" } }; ',
    '$r+="$e]633;A$b"; if($pwd.Provider.Name -eq "FileSystem"){ $r+="$e]633;P;Cwd=$(__ts_esc $pwd.ProviderPath)$b" }; ',
    '$r+=$Global:__ts.P.Invoke(); $r+="$e]633;B$b"; $Global:__ts.H=$(if($h){$h.Id}else{0}); $r }'
  ].join('')
  // With PSReadLine: E (the command line) and C (it runs) when Enter is
  // pressed; the shell then reports its commands reliably (rich).
  const readLine = [
    'if(Test-Path Function:\\PSConsoleHostReadLine){ $Global:__ts.N=$false; $Global:__ts.R=$function:PSConsoleHostReadLine; ',
    'function Global:PSConsoleHostReadLine { $l=$Global:__ts.R.Invoke(); $Global:__ts.X=$true; ',
    '[Console]::Write("$([char]27)]633;E;$(__ts_esc ([string]$l))$([char]7)$([char]27)]633;C$([char]7)"); $l }; ',
    '[Console]::Write("$([char]27)]633;P;HasRichCommandDetection=True$([char]7)") }'
  ].join('')
  const history = "if(Get-Module PSReadLine){ try { Set-PSReadLineOption -AddToHistoryHandler { param($l) if($l.StartsWith(' ')){ 'MemoryOnly' } else { 'MemoryAndFile' } } } catch {} }"
  return ` ${vars}; ${state}; ${esc}; ${prompt}; ${readLine}; ${history}; Clear-Host` // i18n-ignore
}

// bash and zsh (fish and others: the variables only; the terminal then
// works without shell integration). One line.
export function posixInit(env = AGENT_ENV) {
  const pairs = Object.entries(env).map(([k, v]) => `${k}='${String(v).replace(/'/g, "'\\''")}'`) // i18n-ignore
  const vars = `export ${pairs.join(' ')}` // i18n-ignore
  const bash = [
    'HISTCONTROL=ignorespace; __ts_opc=$PROMPT_COMMAND; __ts_ran=0; __ts_in=1; ',
    `__ts_pc(){ local s=$?; if [ "$__ts_ran" = 1 ]; then builtin printf '\\e]633;D;%s\\a' "$s"; else builtin printf '\\e]633;D\\a'; fi; __ts_ran=0; `, // i18n-ignore
    `[ -n "$__ts_opc" ] && eval "$__ts_opc"; builtin printf '\\e]633;P;Cwd=%s\\a' "$(builtin printf '%s' "$PWD" | sed 's/\\\\/\\\\x5c/g; s/;/\\\\x3b/g')"; __ts_in=0; }; `, // i18n-ignore
    `__ts_pre(){ [ "$__ts_in" = 0 ] || return 0; case "$BASH_COMMAND" in __ts_*) return 0;; esac; __ts_in=1; __ts_ran=1; builtin printf '\\e]633;C\\a'; }; `, // i18n-ignore
    `trap '__ts_pre' DEBUG; PROMPT_COMMAND=__ts_pc; PS1="\\[\\e]633;A\\a\\]$PS1\\[\\e]633;B\\a\\]"; builtin printf '\\e]633;P;HasRichCommandDetection=True\\a\\e]633;P;Shell=bash\\a'` // i18n-ignore
  ].join('')
  const zsh = [
    'setopt HIST_IGNORE_SPACE; __ts_ran=0; ',
    `__ts_pc(){ local s=$?; if [[ $__ts_ran == 1 ]]; then printf '\\e]633;D;%s\\a' $s; else printf '\\e]633;D\\a'; fi; __ts_ran=0; printf '\\e]633;P;Cwd=%s\\a' "\${PWD//;/\\\\x3b}"; }; `, // i18n-ignore
    `__ts_pe(){ __ts_ran=1; printf '\\e]633;C\\a'; }; precmd_functions=(__ts_pc $precmd_functions); preexec_functions+=(__ts_pe); `, // i18n-ignore
    `PS1="%{$(printf '\\e]633;A\\a')%}$PS1%{$(printf '\\e]633;B\\a')%}"; printf '\\e]633;P;HasRichCommandDetection=True\\a\\e]633;P;Shell=zsh\\a'` // i18n-ignore
  ].join('')
  return ` ${vars}; if [ -n "$BASH_VERSION" ]; then ${bash}; elif [ -n "$ZSH_VERSION" ]; then ${zsh}; fi; clear` // i18n-ignore
}

// The init line for a shell id of Tessel's ('pwsh', 'powershell', 'gitbash',
// 'wsl', 'cmd'...) or a remote host ('ssh'). cmd has none (Tessel gives an
// agent PowerShell instead).
export function initLineFor(kind, env = AGENT_ENV) {
  if (kind === 'pwsh' || kind === 'powershell') return pwshInit(env)
  if (kind === 'cmd') return null
  return posixInit(env)
}
