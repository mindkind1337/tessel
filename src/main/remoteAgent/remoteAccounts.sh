# Accounts of the agents on an SSH host or a WSL distro (remoteAccounts.js).
# POSIX sh; appended to remoteShell.js's prelude, and run alone in WSL.
#
# Read-only identity: each field is taken from the agent's own file by its
# key name (a pattern per key kept), so a token, a key or any other field
# never leaves the host. A key or token is only ever tested for presence
# (grep -q prints nothing). The one token handled here, Codex's id_token, is
# cut to its claims (the part between the dots, no signature) before it is
# decoded, and only its email and plan are printed.
#
# Output, one record per place an agent keeps a sign-in:
#   @h <os> <home>
#   @e <claude|codex> <folder|->    the login shell's CLAUDE_CONFIG_DIR / CODEX_HOME (login only)
#   @o <claude|codex> <kind>        a key or token the login shell exports (login only)
#   @a <agent> <scope> <id|-> <mtime seconds|-> <folder>
#   v <key> <value>
# scope: default (the agent's own folder), env (CLAUDE_CONFIG_DIR / CODEX_HOME
# set by the login shell), tessel (a folder Tessel made for one account,
# ~/.tessel-server/accounts/<agent>/<id>, see __t_acctmk), orphan (a folder
# there without its marker that still holds a sign-in: an agent that kept
# running wrote it again after its folder was removed).
__ta_flat() { head -c 8388608 "$1" 2>/dev/null | tr -d '\n\r'; }
__ta_str() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]*\"" 2>/dev/null | head -n 1 | sed 's/^"[^"]*"[[:space:]]*:[[:space:]]*"//; s/"$//'; }
# The object a key holds (the first place the key is followed by `: {`, not
# a string equal to it), its own fields only: an object nested in it is
# printed empty (Claude Code's oauthAccount now holds ccOnboardingFlags:
# {...}; a field of that name in there never passes for the account's own).
# Quoted braces skipped.
__ta_obj() {
  awk -v k="\"$1\"" '{
    s = $0; f = 0
    while ((i = index(s, k)) > 0) {
      s = substr(s, i + length(k))
      if (match(s, /^[ \t]*:[ \t]*\{/)) { s = substr(s, RLENGTH); f = 1; break }
    }
    if (!f) exit
    d = 0; q = 0; e = 0; o = ""; n = length(s)
    for (x = 1; x <= n; x++) {
      c = substr(s, x, 1)
      if (q) { if (d == 1) o = o c; if (e) e = 0; else if (c == "\\") e = 1; else if (c == "\"") q = 0; continue }
      if (c == "{") { d++; if (d <= 2) o = o c; continue }
      if (c == "}") { if (d <= 2) o = o c; d--; if (d == 0) { print o; exit }; continue }
      if (c == "\"") q = 1
      if (d == 1) o = o c
    }
  }' 2>/dev/null
}
__ta_set() { grep -q "\"$1\"[[:space:]]*:[[:space:]]*\"[^\"]" 2>/dev/null && echo 1; }
__ta_v() { [ -n "$2" ] && printf 'v %s %s\n' "$1" "$2"; return 0; }
__ta_mt() { stat -c %Y "$1" 2>/dev/null || stat -f %m "$1" 2>/dev/null; }
# A process and everything it started (procps and BusyBox ps; MSYS ps has
# no -o: its plain listing starts with PID PPID).
__ta_kids() { { ps -A -o pid= -o ppid= 2>/dev/null || ps -o pid= -o ppid= 2>/dev/null || ps 2>/dev/null | awk 'NR>1{print $1, $2}'; } | awk -v p="$1" '$2==p{print $1}'; }
__ta_tree() { printf '%s\n' "$1"; for __k in $(__ta_kids "$1"); do __ta_tree "$__k"; done; }
# The whole tree is frozen first, then ended parent first: none of them can
# react to another's end (a `cmd || fallback` starting something new).
__ta_kill() {
  __kl=$(__ta_tree "$1")
  for __k in $__kl; do kill -STOP "$__k" 2>/dev/null; done
  for __k in $__kl; do kill -TERM "$__k" 2>/dev/null; kill -CONT "$__k" 2>/dev/null; done
}
# A command given at most $1 seconds (its output once it ended). The shell's
# own watchdog: stock macOS and BusyBox have no timeout command. Past its
# time the command and what it started are ended. Self-made (this file also
# runs alone, in WSL, without the prelude's helpers).
__ta_tmo() {
  __ts=$1; shift
  __tf=$(mktemp "${TMPDIR:-/tmp}/tessel-acct.XXXXXX" 2>/dev/null) || return 1
  "$@" </dev/null >"$__tf" 2>/dev/null &
  __tp=$!
  ( sleep "$__ts"; __ta_kill "$__tp" ) </dev/null >/dev/null 2>&1 &
  __tw=$!
  wait "$__tp"; __tr=$?
  __ta_kill "$__tw"
  cat "$__tf" 2>/dev/null; rm -f "$__tf"
  return "$__tr"
}
__ta_b64d() {
  if printf 'QQ==' | base64 -d >/dev/null 2>&1; then base64 -d
  elif printf 'QQ==' | base64 -D >/dev/null 2>&1; then base64 -D
  elif command -v openssl >/dev/null 2>&1; then tr -d '\n' | openssl base64 -d -A
  else cat >/dev/null; return 1; fi
}
__ta_head() {
  case $5 in *'
'*) return 1 ;; esac
  __m=$(__ta_mt "$4"); [ -n "$__m" ] || __m=-
  printf '@a %s %s %s %s %s\n' "$1" "$2" "$3" "$__m" "$5"
}
# Settings that make Claude Code use something other than its sign-in (an
# API key helper, a key or token in its env, a gateway): their presence only.
__ta_over() {
  [ -f "$1" ] && [ -r "$1" ] || return 0
  __sf=$(__ta_flat "$1")
  [ "$(printf '%s' "$__sf" | __ta_set apiKeyHelper)" = 1 ] && __ta_v override helper
  [ "$(printf '%s' "$__sf" | __ta_set ANTHROPIC_API_KEY)" = 1 ] && __ta_v override key
  { [ "$(printf '%s' "$__sf" | __ta_set ANTHROPIC_AUTH_TOKEN)" = 1 ] || [ "$(printf '%s' "$__sf" | __ta_set CLAUDE_CODE_OAUTH_TOKEN)" = 1 ]; } && __ta_v override token
  [ "$(printf '%s' "$__sf" | __ta_set ANTHROPIC_BASE_URL)" = 1 ] && __ta_v override gateway
  __sf=
  return 0
}
# Where Claude Code keeps its config (oauthAccount...) for a config folder,
# as it decides: <folder>/.config.json when that file is there and not
# empty (its older name), else $2 (<CLAUDE_CONFIG_DIR>/.claude.json, or
# ~/.claude.json for the default folder).
__ta_cfg() { if [ -f "$1/.config.json" ] && [ -s "$1/.config.json" ]; then printf '%s\n' "$1/.config.json"; else printf '%s\n' "$2"; fi; }
# $1 scope, $2 id, $3 config folder, $4 its .claude.json
__ta_claude() {
  __j=$(__ta_cfg "$3" "$4"); __c="$3/.credentials.json"
  if [ "$1" != tessel ] && [ ! -f "$__j" ] && [ ! -f "$__c" ]; then return 0; fi
  __ta_head claude "$1" "$2" "$__j" "$3" || return 0
  if [ -f "$__j" ] && [ -r "$__j" ]; then
    __o=$(__ta_flat "$__j" | __ta_obj oauthAccount)
    if [ -n "$__o" ]; then
      __ta_v email "$(printf '%s' "$__o" | __ta_str emailAddress)"
      __ta_v org "$(printf '%s' "$__o" | __ta_str organizationName)"
      __ta_v orgId "$(printf '%s' "$__o" | __ta_str organizationUuid)"
      __ta_v account "$(printf '%s' "$__o" | __ta_str accountUuid)"
      __ta_v name "$(printf '%s' "$__o" | __ta_str displayName)"
      __ta_v billing "$(printf '%s' "$__o" | __ta_str billingType)"
      __ta_v planName "$(printf '%s' "$__o" | __ta_str planDisplayName)"
    fi
    [ "$(__ta_flat "$__j" | __ta_set primaryApiKey)" = 1 ] && __ta_v method apikey
  fi
  if [ -f "$__c" ] && [ -r "$__c" ]; then
    [ "$(__ta_flat "$__c" | __ta_set refreshToken)" = 1 ] || [ "$(__ta_flat "$__c" | __ta_set accessToken)" = 1 ] && __ta_v cred file
    __ta_v plan "$(__ta_flat "$__c" | __ta_str subscriptionType)"
    __ta_v tier "$(__ta_flat "$__c" | __ta_str rateLimitTier)"
  fi
  # A folder of Tessel's whose sign-in file is a link (made outside Tessel):
  # what it names is another folder's login; no agent is started on it.
  [ "$1" = tessel ] && { [ -L "$__c" ] || [ -L "$__j" ]; } && __ta_v linked yes
  __ta_over "$3/settings.json"
  return 0
}
# $1 scope, $2 id, $3 CODEX_HOME
__ta_codex() {
  __f="$3/auth.json"
  if [ "$1" != tessel ] && [ ! -f "$__f" ]; then return 0; fi
  __ta_head codex "$1" "$2" "$__f" "$3" || return 0
  [ "$1" = tessel ] && [ -L "$__f" ] && __ta_v linked yes
  [ -f "$__f" ] && [ -r "$__f" ] || return 0
  [ "$(__ta_flat "$__f" | __ta_set refresh_token)" = 1 ] && __ta_v cred file
  [ "$(__ta_flat "$__f" | __ta_set OPENAI_API_KEY)" = 1 ] && __ta_v method apikey
  __ta_v mode "$(__ta_flat "$__f" | __ta_str auth_mode)"
  __ta_v account "$(__ta_flat "$__f" | __ta_str account_id)"
  __t=$(__ta_flat "$__f" | __ta_str id_token)
  [ -n "$__t" ] || return 0
  case $__t in *.*.*) ;; *) __t=; return 0 ;; esac
  __p=${__t#*.}; __p=${__p%%.*}; __t=
  __p=$(printf '%s' "$__p" | tr '_-' '/+')
  case $((${#__p} % 4)) in 2) __p="$__p==" ;; 3) __p="$__p=" ;; esac
  __cl=$(printf '%s\n' "$__p" | __ta_b64d 2>/dev/null | tr -d '\n\r'); __p=
  __ta_v email "$(printf '%s' "$__cl" | __ta_str email)"
  __ta_v plan "$(printf '%s' "$__cl" | __ta_str chatgpt_plan_type)"
  __ta_v org "$(printf '%s' "$__cl" | __ta_str workspace_name)"
  __cl=
  return 0
}
# The other agents: their own folder only (no account folders).
__ta_others() {
  __f="$HOME/.gemini/google_accounts.json"; __g="$HOME/.gemini/oauth_creds.json"
  if [ -f "$__f" ] || [ -f "$__g" ]; then
    __ta_head gemini default - "$__f" "$HOME/.gemini" && {
      __ta_v email "$(__ta_flat "$__f" | __ta_str active)"
      [ "$(__ta_flat "$__g" | __ta_set refresh_token)" = 1 ] && __ta_v cred file
    }
  fi
  __f="$HOME/.copilot/config.json"
  if [ -f "$__f" ]; then
    __o=$(__ta_flat "$__f" | __ta_obj last_logged_in_user)
    if [ -n "$__o" ]; then
      __ta_head copilot default - "$__f" "$HOME/.copilot" && {
        __ta_v login "$(printf '%s' "$__o" | __ta_str login)"
        __ta_v site "$(printf '%s' "$__o" | __ta_str host)"
      }
    fi
  fi
  __f="${GROK_HOME:-$HOME/.grok}/auth.json"
  if [ -f "$__f" ]; then
    __ta_head grok default - "$__f" "${GROK_HOME:-$HOME/.grok}" && {
      __ta_v email "$(__ta_flat "$__f" | __ta_str email)"
      [ "$(__ta_flat "$__f" | __ta_set key)" = 1 ] && __ta_v cred file
    }
  fi
  for __f in "${XDG_CONFIG_HOME:-$HOME/.config}/cursor/cli-config.json" "$HOME/.cursor/cli-config.json"; do
    [ -f "$__f" ] || continue
    __o=$(__ta_flat "$__f" | __ta_obj authInfo)
    [ -n "$__o" ] || continue
    __ta_head cursor default - "$__f" "${__f%/*}" && {
      __ta_v email "$(printf '%s' "$__o" | __ta_str email)"
      __ta_v name "$(printf '%s' "$__o" | __ta_str displayName)"
    }
    break
  done
  __f="${KIMI_CODE_HOME:-$HOME/.kimi-code}/credentials/kimi-code.json"
  [ -f "$__f" ] && __ta_head kimi default - "$__f" "${KIMI_CODE_HOME:-$HOME/.kimi-code}" && __ta_v cred file
  __f="$HOME/.qwen/oauth_creds.json"
  [ -f "$__f" ] && __ta_head qwen default - "$__f" "$HOME/.qwen" && { [ "$(__ta_flat "$__f" | __ta_set refresh_token)" = 1 ] && __ta_v cred file; }
  # Muse Code: its sign-in in auth.json (MUSE_AUTH_PATH, else its config
  # folder), as its launcher reads it; it names no account, so only whether
  # a browser sign-in or a key is there.
  __f="${MUSE_AUTH_PATH:-${XDG_CONFIG_HOME:-$HOME/.config}/muse/auth.json}"
  if [ -f "$__f" ]; then
    __ta_head muse default - "$__f" "${__f%/*}" && {
      { [ "$(__ta_flat "$__f" | __ta_set access_token)" = 1 ] || [ "$(__ta_flat "$__f" | __ta_set refresh_token)" = 1 ]; } && __ta_v cred file
      [ "$(__ta_flat "$__f" | __ta_set api_key)" = 1 ] && __ta_v method apikey
    }
  fi
  __f="${XDG_DATA_HOME:-$HOME/.local/share}/opencode/auth.json"
  if [ -f "$__f" ]; then
    __ta_head opencode default - "$__f" "${__f%/*}" && __ta_flat "$__f" | grep -o '"[A-Za-z0-9_.-]*"[[:space:]]*:[[:space:]]*{[[:space:]]*"type"[[:space:]]*:[[:space:]]*"[a-z]*"' 2>/dev/null | head -n 20 | sed 's/^"\([^"]*\)".*"\([a-z]*\)"$/v provider \1 \2/'
  fi
  return 0
}
# A folder holding a sign-in: a credentials file, or an API key in its .claude.json.
__ta_signed() { [ -f "$1/.credentials.json" ] || [ -f "$1/auth.json" ] || [ "$(__ta_flat "$1/.claude.json" | __ta_set primaryApiKey)" = 1 ]; }
# Leftovers of a removal cut short after its move (accounts/.trash-*, only
# ever made by __t_acctrm): their sign-in first, then the rest.
__ta_trash() {
  for __x in "$HOME/.tessel-server/accounts"/.trash-*; do
    [ -d "$__x" ] && [ ! -L "$__x" ] && [ -O "$__x" ] || continue
    rm -f -- "$__x/.credentials.json" "$__x/auth.json" "$__x/.claude.json"
    rm -rf -- "$__x"
  done
  return 0
}
# Folders Tessel made for one account each: the marker names the agent and id.
__ta_mark() { [ -f "$1/.tessel-account" ] && [ ! -L "$1/.tessel-account" ] && [ "$(head -c 200 "$1/.tessel-account" 2>/dev/null)" = "tessel-account $2 $3" ]; }
__ta_id() { case $1 in ''|*[!0-9a-z]*) return 1 ;; esac; [ ${#1} -le 40 ]; }
# The login shell's CLAUDE_CONFIG_DIR and CODEX_HOME, and which keys or tokens
# it exports (presence only). Its profile runs: Tessel asks once per
# connection (and when you ask for a refresh), never on every check. The
# login shell starts a POSIX sh to print them (so fish and csh work too).
__ta_probe() {
  __sh=${SHELL:-/bin/sh}; __lf=-lc
  case ${__sh##*/} in csh|tcsh) __lf=-c ;; esac
  __lq='printf "@@E %s\n@@F %s\n@@K c%s%s%s x%s\n" "$CLAUDE_CONFIG_DIR" "$CODEX_HOME" "${ANTHROPIC_API_KEY:+k}" "${ANTHROPIC_AUTH_TOKEN:+t}${CLAUDE_CODE_OAUTH_TOKEN:+t}" "${ANTHROPIC_BASE_URL:+g}" "${OPENAI_API_KEY:+k}"'
  __ta_tmo 6 "$__sh" "$__lf" "exec /bin/sh -c '$__lq'" </dev/null 2>/dev/null
}
__ta_flags() {
  case $2 in *k*) printf '@o %s key\n' "$1" ;; esac
  case $2 in *t*) printf '@o %s token\n' "$1" ;; esac
  case $2 in *g*) printf '@o %s gateway\n' "$1" ;; esac
  return 0
}
# $1: login (ask the login shell), dirs <claude folder|-> <codex folder|->
# (what it said before, kept by Tessel), or nothing (this session's own).
__t_accts() {
  printf '@h %s %s\n' "$(uname -s 2>/dev/null | tr -d ' ')" "$HOME"
  __lc=; __lx=
  if [ "$1" = login ]; then
    __le=$(__ta_probe)
    __lc=$(printf '%s\n' "$__le" | sed -n 's/^@@E //p' | tail -n 1)
    __lx=$(printf '%s\n' "$__le" | sed -n 's/^@@F //p' | tail -n 1)
    __lk=$(printf '%s\n' "$__le" | sed -n 's/^@@K //p' | tail -n 1)
    case $__lc in /*) printf '@e claude %s\n' "$__lc" ;; *) printf '@e claude -\n' ;; esac
    case $__lx in /*) printf '@e codex %s\n' "$__lx" ;; *) printf '@e codex -\n' ;; esac
    __c=${__lk%% *}; __x=${__lk#* }
    case $__c in c*) __ta_flags claude "${__c#c}" ;; esac
    case $__x in x*) __ta_flags codex "${__x#x}" ;; esac
  elif [ "$1" = dirs ]; then
    [ "$2" = - ] || __lc=$2
    [ "$3" = - ] || __lx=$3
  else
    __lc=$CLAUDE_CONFIG_DIR; __lx=$CODEX_HOME
  fi
  __ta_claude default - "$HOME/.claude" "$HOME/.claude.json"
  case $__lc in /*) case $__lc in "$HOME/.claude"|"$HOME/.claude/"|"$HOME"/.tessel-server/*) ;; *) __ta_claude env - "${__lc%/}" "${__lc%/}/.claude.json" ;; esac ;; esac
  __ta_codex default - "$HOME/.codex"
  case $__lx in /*) case $__lx in "$HOME/.codex"|"$HOME/.codex/"|"$HOME"/.tessel-server/*) ;; *) __ta_codex env - "${__lx%/}" ;; esac ;; esac
  for __ag in claude codex; do
    __r="$HOME/.tessel-server/accounts/$__ag"
    [ -d "$__r" ] && [ ! -L "$__r" ] || continue
    __n=0
    for __d in "$__r"/*; do
      [ -d "$__d" ] && [ ! -L "$__d" ] || continue
      __i=${__d##*/}
      __ta_id "$__i" || continue
      if __ta_mark "$__d" "$__ag" "$__i"; then __sc=tessel
      elif __ta_signed "$__d"; then __sc=orphan
      else continue; fi
      __n=$((__n+1)); [ "$__n" -le 50 ] || break
      if [ "$__ag" = claude ]; then __ta_claude "$__sc" "$__i" "$__d" "$__d/.claude.json"; else __ta_codex "$__sc" "$__i" "$__d"; fi
    done
  done
  __ta_others
  # The one thing a check ever deletes: Tessel's own leftovers of a removal.
  __ta_trash
  return 0
}
# A Claude login's subscription as Anthropic reports it now (its OAuth
# profile), asked by the host itself, so the login never leaves it: the
# token goes from its file to curl's standard input as a header (-H @-,
# through the shell's own printf), never on a command line or into this
# shell's variables, and only the kept fields of the answer are printed
# (claudeSubscription.js), with the account's id to tell a later sign-in.
# Only Claude's own login is read (its claudeAiOauth object): the same file
# keeps the MCP servers' sign-ins (mcpOAuth), each with its own accessToken
# and expiresAt, which never go anywhere. A login that has expired is not
# used (Tessel never refreshes one). curl reads no ~/.curlrc (-q: no trace,
# proxy or output file of the host's applies to this request). The first
# request that cannot reach the service ends the check (the host cannot
# reach it), and so does the check's own time budget (about 45 s; the
# others are said skipped and keep their last result in Tessel). Without
# curl (or a printf of the shell's own), nothing is asked: `@n nocurl`.
#   @a claude <scope> <id|-> <mtime|-> <folder>
#   v subcheck ok|expired|refused|failed|skipped|nologin
#   v sub_<field> <value>, v account <uuid>
__ta_num() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*[0-9][0-9]*" 2>/dev/null | head -n 1 | sed 's/.*:[[:space:]]*//'; }
__ta_bool() { grep -o "\"$1\"[[:space:]]*:[[:space:]]*[a-z]*" 2>/dev/null | head -n 1 | sed 's/.*:[[:space:]]*//'; }
# Claude's own login object of a credentials file (never an MCP server's).
__ta_login() { __ta_flat "$1" | __ta_obj claudeAiOauth; }
# Prints "ok" when the login's token has a bearer token's shape (it is
# checked before curl starts; the token itself stays in this pipe).
__ta_tokshape() {
  __ta_login "$1" | __ta_str accessToken | {
    read -r __tk
    case $__tk in ''|-*|*[!A-Za-z0-9._~+/=-]*) ;; *) [ "${#__tk}" -le 4096 ] && echo ok ;; esac
  }
}
__ta_now() { __tn=$(date +%s 2>/dev/null); case $__tn in ''|*[!0-9]*) echo 0 ;; *) echo "$__tn" ;; esac; }
# $1 scope, $2 id, $3 config folder
__ta_planone() {
  set +x
  __c="$3/.credentials.json"
  [ -f "$__c" ] && [ -r "$__c" ] && [ ! -L "$__c" ] || return 0
  __ta_head claude "$1" "$2" "$__c" "$3" || return 0
  if [ "$__pdown" = 1 ]; then __ta_v subcheck skipped; return 0; fi
  if [ "$__pend" -gt 0 ] && [ "$(__ta_now)" -ge "$__pend" ]; then __ta_v subcheck skipped; return 0; fi
  [ "$(__ta_tokshape "$__c")" = ok ] || { __ta_v subcheck nologin; return 0; }
  # Its expiry in ms: digits only, leading zeros dropped (0 or none: not said).
  __tx=$(__ta_login "$__c" | __ta_num expiresAt | sed 's/^0*//')
  __tn=$(__ta_now)
  if [ -n "$__tx" ] && [ "${#__tx}" -le 16 ] && [ "$__tn" -gt 0 ] && [ $((__tx / 1000)) -le "$__tn" ]; then __ta_v subcheck expired; return 0; fi
  __tr=$(__ta_login "$__c" | __ta_str accessToken | {
    read -r __tk
    case $__tk in ''|-*|*[!A-Za-z0-9._~+/=-]*) exit 3 ;; esac
    printf 'Authorization: Bearer %s\n' "$__tk"
  } | curl -q -sS --proto =https --max-redirs 0 --connect-timeout 5 --max-time 8 --max-filesize 262144 -H @- -H 'anthropic-beta: oauth-2025-04-20' -H 'User-Agent: claude-code/2.1.0' -w '\n@@S %{http_code}\n' https://api.anthropic.com/api/oauth/profile 2>/dev/null)
  __rc=$?
  case $__rc in
    0) ;;
    6|7|28|35|60) __pdown=1; __tr=; __ta_v subcheck failed; return 0 ;;
    *) __tr=; __ta_v subcheck failed; return 0 ;;
  esac
  __st=$(printf '%s\n' "$__tr" | sed -n 's/^@@S //p' | tail -n 1)
  case $__st in
    200) ;;
    401|403) __tr=; __ta_v subcheck refused; return 0 ;;
    *) __tr=; __ta_v subcheck failed; return 0 ;;
  esac
  __tb=$(printf '%s' "$__tr" | head -c 262144 | tr -d '\n\r'); __tr=
  __ta_v subcheck ok
  for __k in plan_display_name organization_type rate_limit_tier seat_tier billing_type subscription_status claude_code_trial_ends_at; do
    __ta_v "sub_$__k" "$(printf '%s' "$__tb" | __ta_str "$__k")"
  done
  __ta_v sub_has_claude_max "$(printf '%s' "$__tb" | __ta_bool has_claude_max)"
  __ta_v sub_has_claude_pro "$(printf '%s' "$__tb" | __ta_bool has_claude_pro)"
  __ta_v account "$(printf '%s' "$__tb" | __ta_obj account | __ta_str uuid)"
  __tb=
  return 0
}
# $1: dirs <claude folder|-> (the login shell's CLAUDE_CONFIG_DIR, kept by
# Tessel), or nothing. The agent's own folder, that one, and the account
# folders Tessel made (at most 10), within about 45 seconds.
__t_acctplan() {
  set +x
  printf '@h %s %s\n' "$(uname -s 2>/dev/null | tr -d ' ')" "$HOME"
  command -v curl >/dev/null 2>&1 || { printf '@n nocurl\n'; return 0; }
  [ "$(command -v printf)" = printf ] || { printf '@n nocurl\n'; return 0; }
  __pdown=0; __pn=0; __lc=
  __pend=$(__ta_now); [ "$__pend" -gt 0 ] && __pend=$((__pend + 45))
  [ "$1" = dirs ] && [ "$2" != - ] && __lc=$2
  __ta_planone default - "$HOME/.claude"
  case $__lc in /*) case $__lc in "$HOME/.claude"|"$HOME/.claude/"|"$HOME"/.tessel-server/*) ;; *) __ta_planone env - "${__lc%/}" ;; esac ;; esac
  __r="$HOME/.tessel-server/accounts/claude"
  if [ -d "$__r" ] && [ ! -L "$__r" ]; then
    for __d in "$__r"/*; do
      [ -d "$__d" ] && [ ! -L "$__d" ] || continue
      __i=${__d##*/}
      __ta_id "$__i" && __ta_mark "$__d" claude "$__i" || continue
      __pn=$((__pn+1)); [ "$__pn" -le 10 ] || break
      __ta_planone tessel "$__i" "$__d"
    done
  fi
  return 0
}
# Make (new) or repair the folder of one account: ~/.tessel-server/accounts/
# <agent>/<id>, mode 700, with its marker. Claude Code: its conversations,
# plugins, skills... are the default folder's (links into ~/.claude), as on
# the PC, so a pane goes on with its conversation on another account; its
# .claude.json and sign-in are its own. Codex: its settings, hooks and
# instructions are the default ones (links into ~/.codex); its sign-in and
# conversations are its own, as a Codex account's are on the PC
# (remoteShell.js __t_tfile finds them there). At most 30 folders per agent.
# Prints the folder.
__t_acctmk() {
  case $1 in claude|codex) ;; *) return 90 ;; esac
  __ta_id "$2" || return 90
  __s="$HOME/.tessel-server"
  [ -d "$__s/accounts" ] && [ ! -L "$__s/accounts" ] && __ta_trash
  for __x in "$__s" "$__s/accounts" "$__s/accounts/$1" "$__s/accounts/$1/$2"; do
    [ -L "$__x" ] && return 98
    if [ -e "$__x" ]; then
      [ -d "$__x" ] && [ -O "$__x" ] || return 98
    else
      if [ "$__x" = "$__s/accounts/$1/$2" ]; then
        [ "$3" = new ] || return 91
        __n=0
        for __y in "$__s/accounts/$1"/*; do [ -d "$__y" ] && __n=$((__n+1)); done
        [ "$__n" -lt 30 ] || return 97
      fi
      ( umask 077; mkdir "$__x" ) || return 98
    fi
    chmod 700 "$__x" || return 98
  done
  __d="$__s/accounts/$1/$2"
  if [ -e "$__d/.tessel-account" ] || [ -L "$__d/.tessel-account" ]; then
    __ta_mark "$__d" "$1" "$2" || return 98
  else
    [ "$3" = new ] || return 91
    [ -z "$(ls -A "$__d" 2>/dev/null)" ] || return 98
    ( umask 077; printf 'tessel-account %s %s\n' "$1" "$2" >"$__d/.tessel-account" ) || return 98
  fi
  # Its sign-in files are its own, never a link (only its settings and
  # conversations are linked into the default folder): an agent on it would
  # run on the account the link points to and write that one's renewed login.
  for __n in .credentials.json .claude.json .config.json auth.json; do
    [ -L "$__d/$__n" ] && return 98
  done
  if [ "$1" = claude ]; then
    __b="$HOME/.claude"
    [ -d "$__b" ] || ( umask 077; mkdir -p "$__b" ) || return 98
    for __n in projects session-env file-history shell-snapshots todos tasks plans transcripts paste-cache plugins skills agents commands output-styles ide chrome; do
      if [ -e "$__d/$__n" ] || [ -L "$__d/$__n" ]; then continue; fi
      [ -d "$__b/$__n" ] || ( umask 077; mkdir -p "$__b/$__n" ) 2>/dev/null || continue
      ln -s "$__b/$__n" "$__d/$__n" 2>/dev/null
    done
    for __n in settings.json settings.local.json CLAUDE.md keybindings.json; do
      if [ -e "$__d/$__n" ] || [ -L "$__d/$__n" ]; then continue; fi
      [ -f "$__b/$__n" ] && ln -s "$__b/$__n" "$__d/$__n" 2>/dev/null
    done
  else
    __b="$HOME/.codex"
    for __n in config.toml hooks.json AGENTS.md skills prompts rules; do
      if [ -e "$__d/$__n" ] || [ -L "$__d/$__n" ]; then continue; fi
      [ -e "$__b/$__n" ] && ln -s "$__b/$__n" "$__d/$__n" 2>/dev/null
    done
  fi
  # signed: only a folder signed in (a new pane on the host's default
  # account; a sign-in pane starts on an empty one). On macOS Claude Code
  # keeps its login in the Keychain: its profile there counts.
  if [ "$3" = signed ] && ! __ta_signed "$__d"; then
    [ "$1" = claude ] && [ "$(uname -s 2>/dev/null)" = Darwin ] && __ta_oa "$(__ta_cfg "$__d" "$__d/.claude.json")" || return 92
  fi
  printf '%s\n' "$__d"
}
# What a removed folder leaves to the agent's own folder: Codex's
# conversations (sessions, archived_sessions) and either agent's prompt
# history (history.jsonl, added at the end of the default one). Nothing
# else of the folder is kept; never a link followed.
__ta_keep() {
  if [ "$1" = codex ]; then
    for __n in sessions archived_sessions; do
      [ -d "$2/$__n" ] && [ ! -L "$2/$__n" ] || continue
      ( umask 077; mkdir -p "$HOME/.codex/$__n" ) && cp -Rp "$2/$__n/." "$HOME/.codex/$__n/" || return 1
    done
    __b="$HOME/.codex"
  else
    __b="$HOME/.claude"
  fi
  if [ -f "$2/history.jsonl" ] && [ ! -L "$2/history.jsonl" ]; then
    ( umask 077; mkdir -p "$__b" && cat "$2/history.jsonl" >>"$__b/history.jsonl" ) || return 1
  fi
  return 0
}
# Remove a folder Tessel made (its marker checked; never another folder, and
# never the agent's own), or, orphan, a folder there that lost its marker but
# still holds a sign-in (__ta_signed). The sign-in goes first: a removal cut short never
# leaves a login behind. Then its conversations and history are kept
# (__ta_keep), the folder is moved aside at once (a running agent can no
# longer write into it) and deleted. Its links go, never what they point to
# (rm does not follow them). Leftovers of an earlier removal go too.
__t_acctrm() {
  case $1 in claude|codex) ;; *) return 90 ;; esac
  __ta_id "$2" || return 90
  __s="$HOME/.tessel-server"
  for __x in "$__s" "$__s/accounts" "$__s/accounts/$1"; do
    [ -d "$__x" ] && [ ! -L "$__x" ] && [ -O "$__x" ] || return 91
  done
  __d="$__s/accounts/$1/$2"
  [ -d "$__d" ] && [ ! -L "$__d" ] && [ -O "$__d" ] || return 91
  if [ "$3" = orphan ]; then
    { [ -e "$__d/.tessel-account" ] || [ -L "$__d/.tessel-account" ]; } && return 98
    __ta_signed "$__d" || return 98
  else
    __ta_mark "$__d" "$1" "$2" || return 98
  fi
  # Its sign-in first: the credentials, and .claude.json (its profile and
  # any API key in it). A link goes, never what it points to.
  rm -f -- "$__d/.credentials.json" "$__d/auth.json" "$__d/.claude.json" || return 98
  { [ -e "$__d/.credentials.json" ] || [ -e "$__d/auth.json" ] || [ -e "$__d/.claude.json" ]; } && return 98
  __ta_keep "$1" "$__d" || return 98
  __ta_trash
  __tr="$__s/accounts/.trash-$1-$2-$$"
  mv -- "$__d" "$__tr" || return 98
  rm -rf -- "$__tr"
  [ ! -e "$__tr" ] || return 98
}
# The agents panes run (their processes carry TESSEL_PANE_ID=<pane>, from
# the pane's env file), on Linux: which config folder each really uses
# (CLAUDE_CONFIG_DIR / CODEX_HOME in its environment; nothing else of it is
# read). One pass over the processes for all the panes asked, and only this
# user's own (as root, another user's process could pass for a pane). An
# environment is read entry by entry, NUL-separated (a value holding a
# newline cannot pass for another variable), each variable's first entry
# as the agent's getenv sees it.
__ta_mine() { [ -O "$1" ]; }
# An awk that splits its input at NUL bytes (gawk, mawk); else (BusyBox)
# each environment goes through tr first: its NULs made newlines, its own
# newlines (and the marker byte) made \001.
__ta_nulawk() { [ "$(printf 'a\nb\0c\0' | awk 'BEGIN { RS = "\0" } NR == 1 { print ($0 == "a\nb") ? "y" : "n" }' 2>/dev/null)" = y ]; }
# $1 "<pane> <agent> ...", $2 1 (files after it, read NUL-separated) or 0
# (the tr'd stream on stdin, each process after a \002<pid> line).
# Prints "<pid> <pane> <agent> <folder|-|?>" for each process of a pane
# (?: a folder that is not one absolute path on one line).
__ta_envscan() {
  __w=$1; __z=$2; shift 2
  awk -v want="$__w" -v nul="$__z" -v o="$(printf '\001')" -v m="$(printf '\002')" '
    BEGIN { if (nul == 1) RS = "\0"; n = split(want, w, " "); for (i = 1; i < n; i += 2) ag[w[i]] = w[i + 1] }
    nul == 1 && FNR == 1 { pid = FILENAME; sub(/\/environ$/, "", pid); sub(/.*\//, "", pid) }
    nul != 1 && index($0, m) == 1 { pid = substr($0, 2); next }
    index($0, "TESSEL_PANE_ID=") == 1 { if (!(pid in sp)) { sp[pid] = 1; v = substr($0, 16); if (v in ag) pane[pid] = v }; next }
    index($0, "CLAUDE_CONFIG_DIR=") == 1 { if (!(pid in cc)) cc[pid] = substr($0, 19); next }
    index($0, "CODEX_HOME=") == 1 { if (!(pid in cx)) cx[pid] = substr($0, 12); next }
    END {
      for (p in pane) {
        d = ""
        if (ag[pane[p]] == "claude") { if (p in cc) d = cc[p] } else if (p in cx) d = cx[p]
        if (d == "") d = "-"
        else if (substr(d, 1, 1) != "/" || index(d, "\n") || index(d, o)) d = "?"
        print p, pane[p], ag[pane[p]], d
      }
    }' "$@" 2>/dev/null
}
# $1 "<pane> <agent> ...": one `@p <pane> <pid> <folder|->` per pane, or
# `@p <pane> none` (no agent process of it now), `@p <pane> unknown` (no
# /proc, or a folder that cannot be read), `@p <pane> mixed` (its agent
# processes are on different folders: a process left over from an older
# session, or one started with another folder; none is taken for it). An
# agent process: its name is the agent's; else, when it has none of those,
# its command line names it (node .../claude-code).
__ta_panes() {
  if [ ! -d /proc ] || [ ! -r /proc/self/environ ]; then
    printf '%s\n' "$1" | awk '{ for (i = 1; i < NF; i += 2) print "@p " $i " unknown" }'
    return 0
  fi
  __l=
  for __q in /proc/[0-9]*; do
    __ta_mine "$__q" && [ -r "$__q/environ" ] && __l="$__l $__q/environ"
  done
  {
    if [ -z "$__l" ]; then :
    elif __ta_nulawk; then __ta_envscan "$1" 1 $__l
    else
      for __e in $__l; do
        __q=${__e%/environ}; printf '\002%s\n' "${__q##*/}"
        tr '\n\0\002' '\001\n\001' 2>/dev/null <"$__e"; echo
      done | __ta_envscan "$1" 0
    fi
  } | while read -r __q __pn __ag __dv; do
    __r=0
    __a=$(tr '\0' '\n' 2>/dev/null <"/proc/$__q/cmdline" | head -n 1)
    case ${__a##*/} in
      "$__ag"|"$__ag".exe) __r=2 ;;
      *) case $(tr '\0' ' ' 2>/dev/null <"/proc/$__q/cmdline") in *"/$__ag"*|*"$__ag-code"*) __r=1 ;; esac ;;
    esac
    [ "$__r" -gt 0 ] && printf '%s %s %s %s\n' "$__pn" "$__r" "$__q" "$__dv"
  done | awk -v want="$1" '
    { p = $1; r = $2 + 0; d = $0; sub(/^[^ ]+ [^ ]+ [^ ]+ /, "", d)
      if (!(p in best) || r > best[p]) { best[p] = r; dir[p] = d; pid[p] = $3; mix[p] = 0 }
      else if (r == best[p] && d != dir[p]) mix[p] = 1 }
    END {
      n = split(want, w, " ")
      for (i = 1; i < n; i += 2) {
        p = w[i]
        if (!(p in best)) print "@p " p " none"
        else if (mix[p]) print "@p " p " mixed"
        else if (dir[p] == "?") print "@p " p " unknown"
        else print "@p " p " " pid[p] " " dir[p]
      }
    }'
}
# __t_acctpane <pane> <agent> [<pane> <agent>...] (at most 50): the home
# (`@h <os> <home>`, what a folder is checked against), then __ta_panes.
__t_acctpane() {
  [ $# -ge 2 ] && [ $# -le 100 ] && [ $(($# % 2)) -eq 0 ] || return 90
  __w=
  while [ $# -gt 0 ]; do
    case $1 in ''|*[!0-9A-Za-z_-]*) return 90 ;; esac
    case $2 in claude|codex) ;; *) return 90 ;; esac
    __w="$__w $1 $2"; shift 2
  done
  printf '@h %s %s\n' "$(uname -s 2>/dev/null | tr -d ' ')" "$HOME"
  __ta_panes "${__w# }"
}
# Whether a process's environment sets one of these variables (not empty):
# its value is never read into the shell (grep -q prints nothing).
__ta_envhas() {
  __f="/proc/$1/environ"; shift
  for __n in "$@"; do
    tr '\n\0' '\001\n' 2>/dev/null <"$__f" | grep -q "^$__n=." && return 0
  done
  return 1
}
# What a "Copy account details" shows: presence only (yes / no), never a
# value, a token or an email. $1 agent, $2 folder id or -, $3 pane id or -.
__ta_yn() { if "$@"; then echo yes; else echo no; fi; }
__ta_has() { [ "$(__ta_flat "$1" | __ta_set "$2")" = 1 ]; }
__ta_oa() { [ -n "$(__ta_flat "$1" | __ta_obj oauthAccount)" ]; }
__ta_oaem() { [ -n "$(__ta_flat "$1" | __ta_obj oauthAccount | __ta_str emailAddress)" ]; }
__t_acctdiag() {
  case $1 in claude|codex) ;; *) return 90 ;; esac
  case $2 in -) ;; *) __ta_id "$2" || return 90 ;; esac
  case $3 in -) ;; ''|*[!0-9A-Za-z_-]*) return 90 ;; esac
  printf 'd os %s\n' "$(uname -s 2>/dev/null | tr -cd 'A-Za-z0-9_.-')"
  if [ "$1" = claude ]; then __h=$HOME/.claude; __hj=$(__ta_cfg "$HOME/.claude" "$HOME/.claude.json"); __cf=.credentials.json; else __h=$HOME/.codex; __cf=auth.json; fi
  printf 'd home.credentials %s\n' "$(__ta_yn [ -f "$__h/$__cf" ])"
  if [ "$1" = claude ]; then
    printf 'd home.config %s\n' "$(__ta_yn [ -f "$__hj" ])"
    printf 'd home.legacyConfig %s\n' "$(__ta_yn [ -s "$__h/.config.json" ])"
    printf 'd home.oauthAccount %s\n' "$(__ta_yn __ta_oa "$__hj")"
    printf 'd home.email %s\n' "$(__ta_yn __ta_oaem "$__hj")"
  fi
  if [ "$2" != - ]; then
    __d=$HOME/.tessel-server/accounts/$1/$2
    printf 'd folder.exists %s\n' "$(__ta_yn [ -d "$__d" ])"
    printf 'd folder.marker %s\n' "$(__ta_yn __ta_mark "$__d" "$1" "$2")"
    printf 'd folder.credentials %s\n' "$(__ta_yn [ -f "$__d/$__cf" ])"
    printf 'd folder.credentialsLink %s\n' "$(__ta_yn [ -L "$__d/$__cf" ])"
    if [ "$1" = claude ]; then
      printf 'd folder.configLink %s\n' "$(__ta_yn [ -L "$__d/.claude.json" ])"
      __fj=$(__ta_cfg "$__d" "$__d/.claude.json")
      printf 'd folder.config %s\n' "$(__ta_yn [ -f "$__fj" ])"
      printf 'd folder.legacyConfig %s\n' "$(__ta_yn [ -s "$__d/.config.json" ])"
      printf 'd folder.oauthAccount %s\n' "$(__ta_yn __ta_oa "$__fj")"
      printf 'd folder.email %s\n' "$(__ta_yn __ta_oaem "$__fj")"
      printf 'd folder.plan %s\n' "$(__ta_yn __ta_has "$__d/$__cf" subscriptionType)"
      printf 'd folder.projectsLink %s\n' "$(__ta_yn [ -L "$__d/projects" ])"
      printf 'd folder.settingsLink %s\n' "$(__ta_yn [ -L "$__d/settings.json" ])"
    else
      printf 'd folder.apiKey %s\n' "$(__ta_yn __ta_has "$__d/auth.json" OPENAI_API_KEY)"
    fi
  fi
  if [ "$3" != - ]; then
    __pl=$(__ta_panes "$3 $1" | sed -n 's/^@p [^ ]* //p' | head -n 1)
    case $__pl in
      ''|none|unknown|mixed) printf 'd process.found %s\n' "${__pl:-unknown}" ;;
      *)
        __pp=${__pl%% *}; __dv=${__pl#* }
        printf 'd process.found yes\n'
        printf 'd process.configDirSet %s\n' "$(__ta_yn [ "$__dv" != - ])"
        [ "$2" != - ] && printf 'd process.onFolder %s\n' "$(__ta_yn [ "$__dv" = "$HOME/.tessel-server/accounts/$1/$2" ])"
        printf 'd process.keyEnv %s\n' "$(__ta_yn __ta_envhas "$__pp" ANTHROPIC_API_KEY CLAUDE_CODE_OAUTH_TOKEN ANTHROPIC_AUTH_TOKEN)"
        printf 'd process.dbus %s\n' "$(__ta_yn __ta_envhas "$__pp" DBUS_SESSION_BUS_ADDRESS)"
        ;;
    esac
  fi
  printf 'd keyring.secretTool %s\n' "$(__ta_yn command -v secret-tool)"
  return 0
}
# Sign the agent out of its own default login there (Tessel asks you first):
# its credentials file only, as its own logout does. On macOS Claude Code
# keeps its login in the Keychain: that one stays (Tessel says so).
__t_acctout() {
  case $1 in
    claude) __f="$HOME/.claude/.credentials.json" ;;
    codex) __f="$HOME/.codex/auth.json" ;;
    *) return 90 ;;
  esac
  [ -L "$__f" ] && return 98
  [ -f "$__f" ] || return 91
  rm -f -- "$__f" || return 98
}
