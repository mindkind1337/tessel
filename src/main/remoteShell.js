// One SSH session per remote host for the Files, Changes and editor of remote
// projects: Windows' OpenSSH client (ssh.exe) runs `exec /bin/sh` on the
// host with no terminal (-T), and Tessel talks to that shell over its stdin /
// stdout with a tiny line protocol. Nothing is installed on the host.
//
// Why one long-lived session and not one ssh per operation: Windows' OpenSSH
// has no ControlMaster (connection sharing), so every ssh.exe run is a new
// connection: a new handshake (hundreds of ms), and for a host signed in with
// a password or a key passphrase, a new question for every folder opened or
// file saved. One session per host signs in once (through the same askpass
// dialog as the terminals: sshAskpass.js) and each operation is one round
// trip. Its limit: the shell runs one command at a time, so operations are
// queued (a push waits for the listing before it, and the reverse).
//
// Most hosts now run this same session on an exec channel of the host's ONE
// shared ssh2 connection (ssh/sshRemote.js gives a child-process-like object
// as spawnImpl; the terminals use that connection too); ssh.exe remains for
// hosts that need it (ProxyJump, ProxyCommand…). The protocol is the same.
//
// Protocol. When the session starts, Tessel sends a prelude: shell functions
// (the only commands Tessel ever runs there, below) and a random nonce. Each
// request is ONE line
//   __t_q <id> <cap> <seconds> <function> '<arg>' '<arg>' ...
// where id and cap are numbers Tessel makes, the function one of the
// prelude's, and every argument single-quoted by sq() (a quote in it becomes
// '\''; NUL and control characters are refused, so a request can never span
// lines or end early). File contents and commit messages never go in an
// argument: they are sent first, as base64 lines, into a file in the
// session's private temporary folder (__t_up), and the function reads them
// from there. Each command runs with stdin from /dev/null (it can never read
// the protocol), its output bounded at the source (head -c <cap>), and the
// answer comes back base64-encoded between marker lines carrying the nonce:
//   @@T <nonce> <id> <exit code>
//   <stdout, base64>
//   @@T <nonce> <id> e
//   <stderr, base64, 64 KB at most>
//   @@T <nonce> <id> z
// so nothing a command prints can be taken for a marker. Every request has a
// time limit, kept on the host (a watchdog ends the command and what it
// started, the answer is exit code 124, the session goes on) and here a
// little later as a last resort (the session is ended; so does a cancel),
// and the next operation starts a new one.
import { spawn } from 'child_process'
import crypto from 'crypto'
import { ACCOUNT_FUNCTIONS, ACCOUNTS_SHELL } from './remoteAgent/remoteAccounts'

export const READY_TIMEOUT_MS = 180_000 // a password question may wait 2 minutes
export const DEFAULT_TIMEOUT_MS = 30_000
// Past the host's own limit: the session itself is ended.
const HARD_MARGIN_MS = 15_000
export const MAX_RESPONSE = 96 * 1024 * 1024
const MAX_STDERR_TAIL = 4096
const UPLOAD_LINE = 16 * 1024
// The shell runs one request at a time, so a request may wait behind others.
// That wait is bounded too (the request fails as "busy", the session goes
// on), and so is the queue: a slow or stalled host never collects an
// endless pile of requests the window awaits. Background requests (polls,
// readers of agent files) wait behind the user's own and give up sooner.
export const QUEUE_WAIT_MS = 90_000
export const BG_QUEUE_WAIT_MS = 20_000
export const MAX_QUEUED = 64
export const MAX_BG_QUEUED = 16
// Upload lines written per slice (64 x 16 KB of base64: ~1 MB).
const UPLOAD_SLICE_LINES = 64
// A request that waited or ran this long is reported (onSlow).
export const SLOW_REPORT_MS = 5000

// Exit codes of the prelude's functions (the rest are the commands' own).
export const RC = {
  OUTSIDE: 90, // resolves outside the project folder (a link, ..)
  MISSING: 91,
  NOT_FILE: 92,
  TOO_LARGE: 93,
  EXISTS: 94,
  CONFLICT: 95,
  IS_DIR: 96,
  FAILED: 98,
  NOT_REPO: 80,
  NO_TRASH: 99, // no trash on the same disk as the file
  DENIED: 89, // a folder that cannot be read (the folder picker)
  NO_GIT: 81, // git is not installed on the host
  TIMEOUT: 124, // ended by the host-side watchdog
  PIPE: 141 // the output was cut at its cap
}

const CONTROL = /[\u0000-\u001f\u007f]/

// POSIX single quotes: everything literal; a quote closes, is escaped, reopens.
// Refuses what could break the one-line framing or hide in a path.
export function sq(value) {
  const s = String(value)
  if (CONTROL.test(s)) throw new Error('control character in a remote argument') // i18n-ignore internal, caught and replaced
  if (s.length > 8192) throw new Error('remote argument too long') // i18n-ignore internal, caught and replaced
  return `'${s.replace(/'/g, `'\\''`)}'`
}

// An argument already quoted by this module (remotePathArg). Marked with a
// private symbol: nothing from the window (plain strings and objects over
// IPC) can pass for one.
const RAW = Symbol('tessel-remote-raw')
export function rawArg(quoted) {
  return { [RAW]: String(quoted) }
}
export function isRawArg(a) {
  return !!a && typeof a === 'object' && typeof a[RAW] === 'string'
}

// A path argument: "~" / "~/..." starts from the home folder ("$HOME" is
// expanded by the remote shell, the rest stays quoted); else absolute.
export function remotePathArg(path) {
  const p = String(path)
  if (p === '~') return '"$HOME"'
  if (p.startsWith('~/')) return `"$HOME"${sq(p.slice(1))}`
  if (!p.startsWith('/')) throw new Error('remote path not absolute') // i18n-ignore internal, caught and replaced
  return sq(p)
}

// The functions Tessel may call (a request naming anything else is refused).
export const FUNCTIONS = new Set([
  '__t_ls',
  '__t_lsm',
  '__t_stats',
  // Which of some paths in a project are files or folders (terminal links
  // in an SSH pane): one line each, f, d or -, nothing outside the project.
  '__t_kinds',
  '__t_read',
  '__t_write',
  '__t_mk',
  '__t_mv',
  '__t_trash',
  '__t_top',
  '__t_gitin',
  '__t_gitop',
  '__t_hooks',
  '__t_wcl',
  '__t_findn',
  '__t_grep',
  '__t_fp',
  '__t_nop',
  // The sidebar's branch and worktrees of a remote project (read-only).
  '__t_wtl',
  // A Live Share guest's requests on a shared project (remoteFs.js guest,
  // liveShare/shareRemoteFiles.js), each checked here, on the host, in the
  // same request as what it reads or writes (__t_gp): every part of the path
  // below the project folder is a real folder (never a link, never a folder
  // holding a .git: a nested repository), and, with the share's "hide ignored
  // files" on, what git ignores is asked of git itself (git check-ignore, one
  // run per request, the folder's own names only; never a scan of the
  // project). A listing, a stat, a read, a save, a batch of search results,
  // the hooks folder, a name search and a content search.
  '__t_gls',
  '__t_glsm',
  '__t_gst',
  '__t_grd',
  '__t_gwr',
  '__t_gchk',
  '__t_ghk',
  '__t_gfind',
  '__t_ggrep',
  // Add a project on the host (remoteFs.js: browse, clone, create). Not
  // bound to a project folder: the folder picker lists any folder the
  // signed-in user can read (names and kinds only, never contents), and a
  // new project is made in a folder the user chose.
  '__t_browse',
  '__t_clone',
  '__t_newproj',
  // Agents on this host (remoteAgent/remoteAgentSetup.js): put Tessel's shim
  // in ~/.tessel-server and have it register the team tools there.
  '__t_ragent',
  // The agents installed on this host (remoteAgent/remoteAgentSetup.js
  // parseAgentTools): their paths (no agent is run, but Codex for its
  // --version and --help, 2 s each: whether it takes --no-daemon); and what an
  // install there needs (node and npm, npm's folder and whether it is the user's,
  // snap, curl, wget, the user id). Its arguments: the command names looked
  // for (each checked here and there). The login shell's PATH (its own way
  // for fish and csh, read between markers: a .profile may print around it)
  // and npm's folder are asked with a time limit of the shell's own
  // (__t_tmo: stock macOS and BusyBox have no timeout command); one that
  // runs out says `@partial`: what was not found may be there (unknown, to
  // check again), never "missing".
  '__t_agents',
  // An image pasted for an agent in a terminal on this host: written in
  // ~/.tessel-server/paste (kept a day), its path printed (remoteFs.js
  // pasteImage).
  '__t_paste',
  // The agent sessions on this host (the shim's `sessions`): ids, folders,
  // titles, never their contents.
  '__t_rsess',
  // One agent conversation file on this host (Claude Code's transcript or a
  // Codex rollout), found by its session id in the agent's own folder only
  // (or a Codex account folder Tessel made there: its conversations are its
  // own), read-only, a bounded window of it (chat/remoteTranscripts.js). A
  // Codex rollout is looked for first in the day folders its id's time
  // names (a UUIDv7: sessions/YYYY/MM/DD, the days around it), then by a
  // search of the whole folder: one search per read held the host's session
  // for seconds on a host with many sessions.
  '__t_tread',
  // The signed-in user's home folder ($HOME), to tell a "~/…" project from
  // the same folder named by its full path (chat file links).
  '__t_home',
  // Claude Code's skills there (~/.claude/skills and a project's
  // .claude/skills): their SKILL.md files' paths and first bytes only,
  // read-only and bounded (chat/remoteSkills.js).
  '__t_skills',
  // Codex's skills there ($CODEX_HOME/skills, ~/.agents/skills and a
  // project's .agents/skills and .codex/skills), the same way.
  '__t_cxskills',
  // A Claude Code session's sub-agent transcripts (<id>/subagents/*.jsonl
  // next to its transcript): their names, sizes and change times (at most
  // N), and a bounded window of one; read-only, no link followed (jobCost.js).
  '__t_subs',
  '__t_sread',
  // Their meta files (agent-<id>.meta.json: its kind, title, whether it runs
  // in the background), the first bytes of each named one, for the pane's
  // sub-agent list (remoteAgentChildren.js).
  '__t_smeta',
  // A Codex session's sub-agents (spawn_agent threads: rollouts of their own
  // whose first line names it), written in the last two days: their names,
  // sizes and change times, never their contents (remoteAgentChildren.js).
  '__t_cxkids',
  // Which account each agent there is signed in with (identity fields only,
  // never a token), and the folders Tessel makes there for one account each
  // (remoteAgent/remoteAccounts.js).
  ...ACCOUNT_FUNCTIONS
])

// The prelude: POSIX sh, for Linux (GNU, busybox) and macOS / BSD tools.
// Arguments of every function are absolute paths or fixed values from Tessel.
export function prelude(nonce) {
  if (!/^[0-9a-f]{32}$/.test(nonce)) throw new Error('bad nonce') // i18n-ignore internal
  return `unset CDPATH
__T_N=${nonce}
__T_D=$(mktemp -d "\${TMPDIR:-/tmp}/tessel.XXXXXXXX" 2>/dev/null) || { printf '\\n@@R %s mktemp\\n' "$__T_N"; exit 97; }
trap 'rm -rf "$__T_D"' EXIT
trap 'exit 129' HUP
trap 'exit 143' TERM
if printf 'QQ==' | base64 -d >/dev/null 2>&1; then __T_B=d; elif printf 'QQ==' | base64 -D >/dev/null 2>&1; then __T_B=D; elif command -v openssl >/dev/null 2>&1; then __T_B=o; else __T_B=; fi
__t_b64d() { case $__T_B in d) base64 -d ;; D) base64 -D ;; *) tr -d '\\n' | openssl base64 -d -A ;; esac; }
__t_b64e() { case $__T_B in o) openssl base64 ;; *) base64 ;; esac; }
if command -v sha256sum >/dev/null 2>&1; then __T_H=s; elif command -v shasum >/dev/null 2>&1; then __T_H=a; elif command -v openssl >/dev/null 2>&1; then __T_H=o; else __T_H=c; fi
__t_hash() { case $__T_H in s) __h=$(sha256sum <"$1") ;; a) __h=$(shasum -a 256 <"$1") ;; o) __h=$(openssl dgst -sha256 -r <"$1") ;; *) __h=$(cksum <"$1"); printf 'cksum:%s\\n' "$(printf '%s' "$__h" | tr ' ' ':')"; return ;; esac; printf 'sha256:%s\\n' "\${__h%%[ *]*}"; }
if stat -c %s / >/dev/null 2>&1; then __t_sig() { stat -L -c '%s %Y %i %a' "$1"; }; __t_dev() { stat -L -c %d "$1"; }; else __t_sig() { stat -L -f '%z %m %i %Lp' "$1"; }; __t_dev() { stat -L -f %d "$1"; }; fi
if grep -D skip -e x /dev/null >/dev/null 2>&1; [ $? -le 1 ]; then __T_GD=1; else __T_GD=; fi
if mv --help 2>&1 | grep -q -e --no-target-directory; then __T_MT=1; else __T_MT=; fi
__t_kids() { { ps -A -o pid= -o ppid= 2>/dev/null || ps -o pid= -o ppid= 2>/dev/null; } | awk -v p="$1" '$2==p{print $1}'; }
__t_killtree() { for __k in $(__t_kids "$1"); do __t_killtree "$__k"; done; kill -TERM "$1" 2>/dev/null; }
__t_newmode() { printf '%o\\n' $(( 0666 & ~0$(umask) )); }
__t_real() {
  if [ -d "$1" ]; then (cd -P "$1" 2>/dev/null && pwd -P); return; fi
  __d=\${1%/*}; __b=\${1##*/}; [ -n "$__d" ] || __d=/
  __rd=$(cd -P "$__d" 2>/dev/null && pwd -P) || return 1
  __p="\${__rd%/}/$__b"
  if [ -L "$__p" ]; then
    __r=$(readlink -f "$__p" 2>/dev/null) || __r=
    [ -n "$__r" ] || __r=$(realpath "$__p" 2>/dev/null) || __r=
    [ -n "$__r" ] || return 1
    printf '%s\\n' "$__r"; return 0
  fi
  printf '%s\\n' "$__p"
}
__t_in() { case $2 in "$1") return 0 ;; "\${1%/}"/*) return 0 ;; esac; return 1; }
__t_root() { [ -d "$1" ] || return 91; __R=$(__t_real "$1") || return 91; [ -n "$__R" ] || return 91; }
__t_tgt() {
  __t_root "$1" || return $?
  [ -e "$2" ] || [ -L "$2" ] || return 91
  __P=$(__t_real "$2") || return 90
  [ -n "$__P" ] || return 90
  __t_in "$__R" "$__P" || return 90
}
__t_ent() {
  __t_root "$1" || return $?
  __N=\${2##*/}; __d=\${2%/*}; [ -n "$__d" ] || __d=/
  [ -n "$__N" ] || return 90
  __PD=$(__t_real "$__d") || return 91
  [ -d "$__PD" ] || return 91
  __t_in "$__R" "$__PD" || return 90
  __P="\${__PD%/}/$__N"
  [ "$__P" = "$__R" ] && return 90
  return 0
}
__t_git() { __g=$1; shift; LC_ALL=C LANGUAGE= GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0 GIT_MERGE_AUTOEDIT=no GIT_EDITOR=: GIT_PAGER=cat PAGER=cat git -C "$__g" -c core.fsmonitor=false -c log.showSignature=false -c core.quotepath=off "$@"; }
__t_up() { : >"$__T_D/u"; }
if mkfifo "$__T_D/p" 2>/dev/null; then __T_FIFO=1; else __T_FIFO=; fi
__t_q() {
  __id=$1; __cap=$2; __to=$3; shift 3
  rm -f "$__T_D/t"
  if [ -n "$__T_FIFO" ]; then
    head -c "$__cap" <"$__T_D/p" >"$__T_D/o" &
    __h=$!
    ( "$@" ) </dev/null >"$__T_D/p" 2>"$__T_D/e" &
    __c=$!
    ( __i=0; while [ "$__i" -lt "$__to" ]; do sleep 1; kill -0 "$__c" 2>/dev/null || exit 0; __i=$((__i+1)); done; : >"$__T_D/t"; __t_killtree "$__c" ) </dev/null >/dev/null 2>&1 &
    wait "$__c"; __rc=$?
    wait "$__h"
    [ -e "$__T_D/t" ] && __rc=124
  else
    { ( "$@" ) </dev/null 2>"$__T_D/e"; echo $? >"$__T_D/r"; } | head -c "$__cap" >"$__T_D/o"
    __rc=$(cat "$__T_D/r" 2>/dev/null); [ -n "$__rc" ] || __rc=141
  fi
  printf '\\n@@T %s %s %s\\n' "$__T_N" "$__id" "$__rc"
  __t_b64e <"$__T_D/o"
  printf '\\n@@T %s %s e\\n' "$__T_N" "$__id"
  head -c 65536 "$__T_D/e" | __t_b64e
  printf '\\n@@T %s %s z\\n' "$__T_N" "$__id"
  rm -f "$__T_D/o" "$__T_D/e" "$__T_D/r" "$__T_D/c" "$__T_D/t" "$__T_D/u" "$__T_D/m"
}
__t_nop() { :; }
__t_ls() {
  __t_tgt "$1" "$2" || return $?
  [ -d "$__P" ] || return 92
  __n=0
  for __f in "$__P"/* "$__P"/.[!.]* "$__P"/..?*; do
    [ -e "$__f" ] || [ -L "$__f" ] || continue
    __n=$((__n+1)); [ "$__n" -gt "$3" ] && break
    if [ -L "$__f" ]; then if [ -d "$__f" ]; then __k=L; else __k=l; fi
    elif [ -d "$__f" ]; then __k=d; elif [ -f "$__f" ]; then __k=f; else __k=o; fi
    printf '%s %s\\000' "$__k" "\${__f##*/}"
  done
}
__t_lsm() {
  __lr=$1; __lmx=$2; __lch=$3; __ldt=$4; shift 4
  for __ld in "$@"; do
    __lk=D; __lg=0; __ls=
    while :; do
      __t_tgt "$__lr" "$__ld"; __lrc=$?
      [ "$__lrc" = 0 ] && { [ -d "$__P" ] || __lrc=92; }
      printf '%s %s %s\\000' "$__lk" "$__lrc" "$__ls"
      [ "$__lrc" = 0 ] || break
      __n=0; __vis=0; __ls=
      for __f in "$__P"/* "$__P"/.[!.]* "$__P"/..?*; do
        [ -e "$__f" ] || [ -L "$__f" ] || continue
        __n=$((__n+1)); [ "$__n" -gt "$__lmx" ] && break
        if [ -L "$__f" ]; then if [ -d "$__f" ]; then __k=L; else __k=l; fi
        elif [ -d "$__f" ]; then __k=d; elif [ -f "$__f" ]; then __k=f; else __k=o; fi
        __b=\${__f##*/}
        printf '%s %s\\000' "$__k" "$__b"
        case $__b in .git) continue ;; .*) [ "$__ldt" = 1 ] || continue ;; esac
        __vis=$((__vis+1)); [ "$__k" = d ] && __ls=$__b
      done
      [ "$__lch" = 1 ] && [ "$__vis" = 1 ] && [ -n "$__ls" ] && [ "$__lg" -lt 64 ] || break
      __ld="\${__ld%/}/$__ls"; __lk=C; __lg=$((__lg+1))
    done
  done
}
__t_stats() {
  __t_root "$1" || return $?; shift
  for __f in "$@"; do
    if __p=$(__t_real "$__f") && [ -n "$__p" ] && __t_in "$__R" "$__p" && [ -f "$__p" ] && __s=$(__t_sig "$__p"); then printf '%s\\n' "$__s"; else printf '%s\\n' -; fi
  done
}
__t_kinds() {
  __t_root "$1" || return $?; shift
  for __f in "$@"; do
    if __p=$(__t_real "$__f") && [ -n "$__p" ] && __t_in "$__R" "$__p"; then
      if [ -f "$__p" ]; then printf 'f\\n'; elif [ -d "$__p" ]; then printf 'd\\n'; else printf '%s\\n' -; fi
    else printf '%s\\n' -; fi
  done
}
__t_read() {
  __t_tgt "$1" "$2" || return $?
  if [ ! -f "$__P" ]; then [ -d "$__P" ] && return 96; return 92; fi
  __s=$(__t_sig "$__P") || return 91
  [ "\${__s%% *}" -le "$3" ] || { printf '%s\\n' "$__s"; return 93; }
  head -c "$(($3+1))" "$__P" >"$__T_D/c" || return 98
  [ "$(($(wc -c <"$__T_D/c")))" -le "$3" ] || { __t_sig "$__P"; return 93; }
  printf '%s %s\\n' "$(__t_sig "$__P")" "$(__t_hash "$__T_D/c")"
  cat "$__T_D/c"
}
__t_same() {
  [ -e "$1" ] || return 0
  if [ -n "$2" ]; then [ "$(__t_hash "$1")" = "$2" ]; return; fi
  if [ -n "$3" ]; then __s=$(__t_sig "$1") || return 1; [ "\${__s% *}" = "$3" ]; return; fi
  return 0
}
__t_write() {
  case $5 in ''|600) ;; *) return 90 ;; esac
  case $6 in ''|new) ;; *) return 90 ;; esac
  __t_root "$1" || return $?
  __E=
  if [ -e "$2" ] || [ -L "$2" ]; then
    __t_tgt "$1" "$2" || return $?
    [ -d "$__P" ] && return 96
    [ -f "$__P" ] || return 92
    __E=1
    [ -z "$6" ] || { __t_sig "$__P"; return 95; }
  else
    __t_ent "$1" "$2" || return $?
  fi
  __t_same "$__P" "$3" "$4" || { __t_sig "$__P"; return 95; }
  __tmp=$(mktemp "\${__P%/*}/.\${__P##*/}.tessel-XXXXXX") || return 98
  if ! __t_b64d <"$__T_D/u" >"$__tmp"; then rm -f "$__tmp"; return 98; fi
  if [ -n "$__E" ]; then __m=$(__t_sig "$__P"); __m=\${__m##* }; elif [ -n "$5" ]; then __m=$5; else __m=$(__t_newmode); fi
  chmod "$__m" "$__tmp" 2>/dev/null
  __t_same "$__P" "$3" "$4" || { rm -f "$__tmp"; __t_sig "$__P"; return 95; }
  if [ -n "$6" ]; then
    if [ -n "$__T_MT" ]; then ln -T "$__tmp" "$__P" 2>/dev/null; else ln "$__tmp" "$__P" 2>/dev/null; fi
    __lrc=$?
    if [ "$__lrc" = 0 ]; then
      rm -f "$__tmp"
      if [ -d "$__P" ] && [ ! -L "$__P" ]; then rm -f "$__P/\${__tmp##*/}"; return 95; fi
    else
      rm -f "$__tmp"
      { [ -e "$__P" ] || [ -L "$__P" ]; } && { __t_sig "$__P" 2>/dev/null; return 95; }
      return 98
    fi
  else
    mv -f "$__tmp" "$__P" || { rm -f "$__tmp"; return 98; }
  fi
  rm -f "$__T_D/u"
  printf '%s %s\\n' "$(__t_sig "$__P")" "$(__t_hash "$__P")"
}
__t_name() { case $1 in ''|.|..|*/*) return 1 ;; esac; return 0; }
__t_mk() {
  __t_ent "$1" "$2" || return $?
  __t_name "$__N" || return 90
  { [ -e "$__P" ] || [ -L "$__P" ]; } && return 94
  if [ "$3" = 1 ]; then mkdir "$__P" || return 98; else (set -C; : >"$__P") || return 98; fi
}
__t_mv() {
  __t_name "$3" || return 90
  __t_ent "$1" "$2" || return $?
  { [ -e "$__P" ] || [ -L "$__P" ]; } || return 91
  __to="\${__PD%/}/$3"
  { [ -e "$__to" ] || [ -L "$__to" ]; } && return 94
  if [ -n "$__T_MT" ]; then mv -T -n "$__P" "$__to" || return 98; else mv -n "$__P" "$__to" || return 98; fi
  { [ -e "$__P" ] || [ -L "$__P" ]; } && return 94
  return 0
}
__t_trash() {
  __t_ent "$1" "$2" || return $?
  { [ -e "$__P" ] || [ -L "$__P" ]; } || return 91
  __tr="\${XDG_DATA_HOME:-$HOME/.local/share}/Trash"
  mkdir -p "$__tr/files" "$__tr/info" || return 98
  if [ "$(__t_dev "$__PD")" != "$(__t_dev "$__tr/files")" ]; then
    __mt=$(df -P "$__PD" 2>/dev/null | awk 'NR==2{print $NF}')
    [ -n "$__mt" ] || return 99
    __tr="\${__mt%/}/.Trash-$(id -u)"
    mkdir -p "$__tr/files" "$__tr/info" 2>/dev/null && chmod 700 "$__tr" 2>/dev/null
    [ -d "$__tr/files" ] && [ "$(__t_dev "$__PD")" = "$(__t_dev "$__tr/files")" ] || return 99
  fi
  __b=$__N; __i=1
  while [ -e "$__tr/files/$__b" ] || [ -L "$__tr/files/$__b" ] || [ -e "$__tr/info/$__b.trashinfo" ]; do __i=$((__i+1)); [ "$__i" -gt 999 ] && return 98; __b="$__N.$__i"; done
  (set -C; printf '[Trash Info]\\nPath=%s\\nDeletionDate=%s\\n' "$3" "$4" >"$__tr/info/$__b.trashinfo") || return 98
  mv "$__P" "$__tr/files/$__b" || { rm -f "$__tr/info/$__b.trashinfo"; return 98; }
  printf '%s\\n' "$__tr/files/$__b"
}
__t_top() {
  __t_root "$1" || return $?
  __t=$(__t_git "$__R" rev-parse --show-toplevel 2>/dev/null) || { printf '%s\\n' "$__R"; return 80; }
  __t=$(__t_real "$__t") || return 91
  printf '%s\\n%s\\n' "$__R" "$__t"
}
__t_gitin() {
  __t_root "$1" || return $?
  __t_in "$2" "$__R" || return 90
  __g=$2; shift 2
  if [ "$1" = -F ]; then shift; __t_b64d <"$__T_D/u" >"$__T_D/m" || return 98; __t_git "$__g" "$@" -F "$__T_D/m"; return; fi
  __t_git "$__g" "$@"
}
__t_gitop() {
  __t_root "$1" || return $?
  __t_in "$2" "$__R" || return 90
  __gd=$(__t_git "$2" rev-parse --absolute-git-dir 2>/dev/null) || return 0
  if [ -e "$__gd/rebase-merge" ] || [ -e "$__gd/rebase-apply" ]; then echo rebase; elif [ -e "$__gd/MERGE_HEAD" ]; then echo merge; elif [ -e "$__gd/CHERRY_PICK_HEAD" ]; then echo cherry-pick; fi
}
__t_hooks() {
  __t_root "$1" || return $?
  __t_in "$2" "$__R" || return 90
  __gd=$(__t_git "$2" rev-parse --git-common-dir 2>/dev/null) || return 0
  case $__gd in /*) ;; *) __gd="\${2%/}/$__gd" ;; esac
  [ -d "$__gd/hooks" ] || return 0
  for __f in "$__gd/hooks"/*; do
    [ -f "$__f" ] && [ -x "$__f" ] || continue
    case $__f in *.sample) continue ;; esac
    printf '%s\\000' "\${__f##*/}"
  done
}
__t_wcl() {
  __t_root "$1" || return $?
  __t_in "$2" "$__R" || return 90
  __g=$2; shift 2; __left=33554432
  for __f in "$@"; do
    __p="\${__g%/}/$__f"
    if [ -L "$__p" ]; then echo 1; continue; fi
    __q=$(__t_real "$__p") && __t_in "$__R" "$__q" || { echo -; continue; }
    if [ -f "$__p" ] && __s=$(__t_sig "$__p") && __z=\${__s%% *} && [ "$__z" -le 2097152 ] && [ "$__z" -le "$__left" ]; then
      __left=$((__left-__z))
      if [ "$(tr -d '\\000' <"$__p" | wc -c)" -eq "$__z" ]; then awk 'END{print NR}' "$__p"; continue; fi
    fi
    echo -
  done
}
__t_findn() {
  __t_root "$1" || return $?
  if [ "$3" = d ]; then
    find "$__R/." \\( -name .git -o -name node_modules -o -name dist -o -name build -o -name out -o -name .next -o -name .cache -o -name target -o -name .venv -o -name __pycache__ \\) -prune -o -iname "$2" -type d -print0
  else
    find "$__R/." \\( -name .git -o -name node_modules -o -name dist -o -name build -o -name out -o -name .next -o -name .cache -o -name target -o -name .venv -o -name __pycache__ \\) -prune -o -iname "$2" ! -type d ! -type l -print0
  fi
}
__t_grep() {
  __t_root "$1" || return $?
  cd "$__R" || return 91
  if [ "$2" = git ]; then shift 2; __t_git "$__R" "$@"; return; fi
  __q=$3
  set -- -rnIiF
  [ -n "$__T_GD" ] && set -- "$@" -D skip
  LC_ALL=C grep "$@" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=out --exclude-dir=.next --exclude-dir=.cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=__pycache__ -e "$__q" .
}
__t_fp() {
  __t_root "$1" || return $?
  case $2 in ''|*[!0-9]*) return 90 ;; esac
  __m="$__T_D/fp$2"
  if [ ! -e "$__m" ]; then : >"$__m"; echo init; return 0; fi
  : >"$__m.n"
  find "$__R/." \\( -name node_modules -o -name dist -o -name build -o -name out -o -name .next -o -name .cache -o -name target -o -name .venv -o -name __pycache__ -o -path '*/.git/objects' -o -path '*/.git/logs' \\) -prune -o -newer "$__m" -print0 2>/dev/null | head -c "\${3:-65536}" >"$__T_D/fpl"
  mv -f "$__m.n" "$__m"
  if [ -s "$__T_D/fpl" ]; then printf 'changed\\000'; cat "$__T_D/fpl"; else echo same; fi
  rm -f "$__T_D/fpl"
}
__t_gd() { [ -f "$1/HEAD" ] && [ -d "$1/objects" ] && [ -d "$1/refs" ]; }
__t_gw() {
  __gc=$1
  __go=$IFS; IFS=/; set -f; set -- $2; IFS=$__go; set +f
  [ $# -gt 0 ] || return 90
  while [ $# -gt 0 ]; do
    case $1 in ''|.|..) return 90 ;; esac
    __gc=$__gc/$1
    [ -L "$__gc" ] && return 90
    if [ -d "$__gc" ]; then
      if [ -e "$__gc/.git" ] || [ -L "$__gc/.git" ]; then return 90; fi
      __t_gd "$__gc" && return 90
    elif [ $# -gt 1 ]; then return 91
    fi
    shift
  done
  return 0
}
__t_gp() {
  __t_root "$1" || return $?
  __gb=\${1%/}
  [ "$2" = "$1" ] || [ "$2" = "$__gb" ] && return 0
  case $2 in "$__gb"/*) ;; *) return 90 ;; esac
  __t_gw "$__gb" "\${2#"$__gb"/}"
}
__t_grel() { __gb=\${1%/}; __gq=; [ "$2" = "$1" ] || [ "$2" = "$__gb" ] || __gq=\${2#"$__gb"/}; }
__t_gup() {
  __gu=$1
  while [ -n "$__gu" ]; do
    if [ -e "$__gu/.git" ] || [ -L "$__gu/.git" ]; then return 0; fi
    case $__gu in */*) __gu=\${__gu%/*} ;; *) __gu= ;; esac
  done
  [ -e /.git ]
}
__t_gign() {
  __gt=
  command -v git >/dev/null 2>&1 && __gt=$(__t_git "$1" rev-parse --is-inside-work-tree 2>/dev/null)
  if [ "$__gt" = true ]; then
    printf '/@@I y\\000'
    __t_git "$1" check-ignore --no-index -z --stdin 2>"$__T_D/ge"; __gr=$?
    if [ "$__gr" -le 1 ] && [ ! -s "$__T_D/ge" ]; then printf '/@@I e\\000'
    elif [ "$__gr" = 129 ] || grep -q -e 'not a git command' -e 'unknown option' "$__T_D/ge" 2>/dev/null; then printf '/@@I o\\000'
    fi
    rm -f "$__T_D/ge"
    return 0
  fi
  if __t_gup "$1"; then printf '/@@I x\\000'; else printf '/@@I n\\000'; fi
}
__t_gone() {
  [ "$3" = 1 ] || return 0
  __t_grel "$1" "$2"
  [ -n "$__gq" ] || return 0
  printf './%s\\000' "$__gq" | __t_gign "$__R" | tr '\\000' '\\n' >"$__T_D/gi"
  read -r __gs <"$__T_D/gi" || __gs=
  case $__gs in
    '/@@I n') return 0 ;;
    '/@@I y')
      grep -q -x -F -e '/@@I o' "$__T_D/gi" && return 87
      grep -q -x -F -e '/@@I e' "$__T_D/gi" || return 97
      grep -q -x -F -e "./$__gq" "$__T_D/gi" && return 91
      grep -q -x -F -e "$__gq" "$__T_D/gi" && return 91
      return 0 ;;
  esac
  return 97
}
__t_gls() {
  __t_gp "$1" "$2" || return $?
  __t_grel "$1" "$2"
  __P=$__R; [ -z "$__gq" ] || __P="\${__R%/}/$__gq"
  [ -d "$__P" ] || return 92
  : >"$__T_D/gn"
  [ -z "$__gq" ] || { printf './%s\\000' "$__gq" >>"$__T_D/gn"; __gq="$__gq/"; }
  __n=0
  for __f in "$__P"/* "$__P"/.[!.]* "$__P"/..?*; do
    [ -e "$__f" ] || [ -L "$__f" ] || continue
    __n=$((__n+1)); [ "$__n" -gt "$3" ] && break
    __b=\${__f##*/}
    if [ -L "$__f" ]; then __k=l
    elif [ -d "$__f" ]; then if [ -e "$__f/.git" ] || [ -L "$__f/.git" ] || __t_gd "$__f"; then __k=r; else __k=d; fi
    elif [ -f "$__f" ]; then __k=f; else __k=o; fi
    printf '%s %s\\000' "$__k" "$__b"
    case $__k$__b in l*|r*|?.git) ;; *) printf './%s%s\\000' "$__gq" "$__b" >>"$__T_D/gn" ;; esac
  done
  [ "$4" = 1 ] && __t_gign "$__R" <"$__T_D/gn"
  rm -f "$__T_D/gn"
  return 0
}
__t_glsm() {
  __lr=$1; __lmx=$2; __lig=$3; shift 3
  for __ld in "$@"; do
    __t_gls "$__lr" "$__ld" "$__lmx" "$__lig" >"$__T_D/gm"; __lrc=$?
    printf '/@@D %s\\000' "$__lrc"
    [ "$__lrc" = 0 ] && cat "$__T_D/gm"
  done
  rm -f "$__T_D/gm"
  return 0
}
__t_gst() { __t_gp "$1" "$2" || return $?; __t_gone "$1" "$2" "$3" || return $?; __t_stats "$1" "$2"; }
__t_grd() { __t_gp "$1" "$2" || return $?; __t_gone "$1" "$2" "$4" || return $?; __t_read "$1" "$2" "$3"; }
__t_gwr() {
  __t_gp "$1" "$2" || return $?
  __t_grel "$1" "$2"
  case "/$(printf '%s' "$__gq" | LC_ALL=C tr 'A-Z' 'a-z')/" in */.git/*) return 90 ;; esac
  [ -n "$3" ] || [ "$5" = new ] || return 90
  __tmp=
  trap '[ -n "$__tmp" ] && rm -f "$__tmp"' EXIT
  trap '[ -n "$__tmp" ] && rm -f "$__tmp"; exit 124' HUP TERM PIPE
  __t_gone "$1" "$2" "$6" || return $?
  __t_write "$1" "$2" "$3" "$4" '' "$5"
}
__t_gchk() {
  __t_root "$1" || return $?
  __gb=\${1%/}
  __t_b64d <"$__T_D/u" >"$__T_D/m" || return 98
  : >"$__T_D/gk"
  while IFS= read -r __gl || [ -n "$__gl" ]; do
    [ -n "$__gl" ] || continue
    __t_gw "$__gb" "$__gl" || continue
    [ -e "$__gb/$__gl" ] && [ ! -L "$__gb/$__gl" ] || continue
    printf '%s\\000' "$__gl"
    printf './%s\\000' "$__gl" >>"$__T_D/gk"
  done <"$__T_D/m"
  printf '/@@C\\000'
  [ "$2" = 1 ] && __t_gign "$__R" <"$__T_D/gk"
  rm -f "$__T_D/gk" "$__T_D/m"
  return 0
}
__t_gabs() { case $1 in -*|'') return 1 ;; esac; __q=$(cd "$__R" 2>/dev/null && __t_real "$1") && [ -n "$__q" ]; }
__t_ghk() {
  __t_root "$1" || return $?
  printf 'R %s\\n' "$__R"
  printf 'M %s\\n' "$HOME"
  __q=$(cd -P "$HOME" 2>/dev/null && pwd -P) && [ -n "$__q" ] && printf 'P %s\\n' "$__q"
  __t=
  command -v git >/dev/null 2>&1 && __t=$(__t_git "$__R" rev-parse --show-toplevel 2>/dev/null)
  if [ -z "$__t" ]; then
    __gd=
    command -v git >/dev/null 2>&1 && __gd=$(__t_git "$__R" rev-parse --git-dir 2>/dev/null)
    if [ -n "$__gd" ] && __t_gabs "$__gd"; then printf 'G %s\\nX\\n' "$__q"; return 0; fi
    if __t_gup "$__R"; then printf 'X\\n'; else printf 'N\\n'; fi
    return 0
  fi
  __t=$(__t_real "$__t") || return 91
  printf 'T %s\\n' "$__t"
  __gd=$(__t_git "$__R" rev-parse --git-dir 2>/dev/null) && __t_gabs "$__gd" && printf 'G %s\\n' "$__q"
  __gd=$(__t_git "$__R" rev-parse --git-common-dir 2>/dev/null) && __t_gabs "$__gd" && printf 'C %s\\n' "$__q"
  __h=$(__t_git "$__R" config --get core.hooksPath 2>/dev/null); __hr=$?
  [ "$__hr" = 1 ] && return 0
  [ "$__hr" = 0 ] || return 98
  printf 'H %s\\n' "$__h"
  case $__h in '') return 0 ;; '~'*) return 0 ;; /*) __a=$__h ;; *) __a="\${__t%/}/$__h" ;; esac
  __q=$(__t_real "$__a" 2>/dev/null) && [ -n "$__q" ] && printf 'Q %s\\n' "$__q"
  return 0
}
__t_gfind() {
  __t_findn "$1" "$2" d
  printf '/@@F\\000'
  __t_findn "$1" "$2" f
}
__t_ggrep() {
  __t_root "$1" || return $?
  __gq=$2; shift 2
  cd "$__R" || return 91
  if command -v git >/dev/null 2>&1 && [ "$(__t_git "$__R" rev-parse --is-inside-work-tree 2>/dev/null)" = true ]; then
    printf 'G\\n'
    __t_git "$__R" "$@"
  elif printf 'x\\n' | grep --null -n -e x >/dev/null 2>&1; then
    printf 'P\\n'
    set -- -rnIiF --null
    [ -n "$__T_GD" ] && set -- "$@" -D skip
    LC_ALL=C grep "$@" --exclude-dir=.git --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=build --exclude-dir=out --exclude-dir=.next --exclude-dir=.cache --exclude-dir=target --exclude-dir=.venv --exclude-dir=__pycache__ -e "$__gq" .
  else
    printf 'L\\n'
    LC_ALL=C grep -rliF -e "$__gq" . 2>/dev/null | head -n 500 | while IFS= read -r __gf; do
      [ -f "$__gf" ] || continue
      printf '/@@F %s\\n' "$__gf"
      LC_ALL=C grep -niF -e "$__gq" -- "$__gf" 2>/dev/null | head -n 50
    done
  fi
}
__t_wtl() {
  __t_root "$1" || return $?
  case $2 in ''|*[!0-9]*) return 90 ;; esac
  command -v git >/dev/null 2>&1 || return 81
  __t=$(__t_git "$__R" -c core.hooksPath=/nonexistent-tessel-no-hooks rev-parse --show-toplevel 2>/dev/null) || return 80
  __q=$(__t_real "$__t") && [ -n "$__q" ] && __t=$__q
  __b=$(__t_git "$__R" -c core.hooksPath=/nonexistent-tessel-no-hooks symbolic-ref -q --short HEAD 2>/dev/null) || __b=
  __h=$(__t_git "$__R" -c core.hooksPath=/nonexistent-tessel-no-hooks rev-parse -q --verify HEAD 2>/dev/null) || __h=
  printf 'tessel-wtl 1\\nroot %s\\ntop %s\\nbranch %s\\nhead %s\\n\\n' "$__R" "$__t" "$__b" "$__h"
  __t_git "$__R" -c core.hooksPath=/nonexistent-tessel-no-hooks -c protocol.ext.allow=never worktree list --porcelain | {
    __n=0
    while IFS= read -r __l; do
      case $__l in
        'worktree '*)
          __n=$((__n+1)); [ "$__n" -gt "$2" ] && break
          __w=\${__l#worktree }
          __q=$(cd -P "$__w" 2>/dev/null && pwd -P) || __q=
          [ -n "$__q" ] || __q=$__w
          printf 'worktree %s\\n' "$__q" ;;
        *) printf '%s\\n' "$__l" ;;
      esac
    done
  }
}
__t_dir() { [ -d "$1" ] || return 91; __PD=$(cd -P "$1" 2>/dev/null && pwd -P) || return 89; [ -n "$__PD" ] || return 91; }
__t_browse() {
  __t_dir "$1" || return $?
  printf '%s\\000' "$__PD"
  [ -r "$__PD" ] && [ -x "$__PD" ] || return 89
  __n=0
  for __f in "\${__PD%/}"/* "\${__PD%/}"/.[!.]* "\${__PD%/}"/..?*; do
    [ -e "$__f" ] || [ -L "$__f" ] || continue
    __n=$((__n+1)); [ "$__n" -gt "$2" ] && break
    if [ -L "$__f" ]; then if [ -d "$__f" ]; then __k=L; else __k=l; fi
    elif [ -d "$__f" ]; then __k=d; elif [ -f "$__f" ]; then __k=f; else __k=o; fi
    printf '%s %s\\000' "$__k" "\${__f##*/}"
  done
}
__t_clone() {
  __t_name "$2" || return 90
  __t_dir "$1" || return $?
  __P="\${__PD%/}/$2"
  { [ -e "$__P" ] || [ -L "$__P" ]; } && return 94
  command -v git >/dev/null 2>&1 || return 81
  ( GIT_SSH_COMMAND=\${GIT_SSH_COMMAND:-'ssh -o BatchMode=yes'}; GCM_INTERACTIVE=never; export GIT_SSH_COMMAND GCM_INTERACTIVE
    __t_git "$__PD" -c protocol.ext.allow=never -c protocol.fd.allow=never clone -- "$3" "$2" >/dev/null ) || return 98
  [ -d "$__P" ] || return 98
  printf '%s\\n' "$__P"
}
__t_newproj() {
  __t_name "$2" || return 90
  __t_dir "$1" || return $?
  __P="\${__PD%/}/$2"
  command -v git >/dev/null 2>&1 || return 81
  __new=
  if [ -e "$__P" ] || [ -L "$__P" ]; then
    [ -d "$__P" ] && [ ! -L "$__P" ] || return 94
    [ -z "$(ls -A "$__P" 2>/dev/null)" ] || return 94
  else
    mkdir "$__P" || return 98
    __new=1
  fi
  if ! __t_git "$__P" init -q >/dev/null; then if [ -n "$__new" ]; then rm -rf "$__P"; else rm -rf "$__P/.git"; fi; return 98; fi
  __t_git "$__P" commit -q --allow-empty --no-verify -m 'Initial commit' >/dev/null 2>&1
  printf '%s\\n' "$__P"
}
__t_findnode() {
  __nd=$(command -v node 2>/dev/null) || __nd=
  case $__nd in /*) ;; *) __nd= ;; esac
  if [ -z "$__nd" ]; then __nd=$("\${SHELL:-/bin/sh}" -lc 'command -v node' </dev/null 2>/dev/null | tail -n 1) || __nd=; case $__nd in /*) ;; *) __nd= ;; esac; fi
  if [ -z "$__nd" ]; then for __c in "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.volta/bin/node "$HOME"/.local/bin/node /usr/local/bin/node /opt/homebrew/bin/node; do [ -x "$__c" ] && __nd=$__c; done; fi
  if [ -z "$__nd" ]; then __nd=$(ls -td -- "$HOME"/.vscode-server/cli/servers/*/server/node "$HOME"/.vscode-server/bin/*/node "$HOME"/.cursor-server/cli/servers/*/server/node "$HOME"/.cursor-server/bin/*/node 2>/dev/null | head -n 1) || __nd=; case $__nd in /*) ;; *) __nd= ;; esac; fi
  [ -n "$__nd" ] && [ -x "$__nd" ]
}
__t_rsess() {
  case $1 in ''|*[!0-9]*) return 90 ;; esac
  __s="$HOME/.tessel-server"
  [ -d "$__s" ] && [ ! -L "$__s" ] && [ -O "$__s" ] || return 81
  [ -f "$__s/bin/tessel-shim.cjs" ] && [ ! -L "$__s/bin/tessel-shim.cjs" ] || return 81
  __nd=$(cat "$__s/bin/NODE" 2>/dev/null) || __nd=
  case $__nd in /*) [ -f "$__nd" ] && [ -x "$__nd" ] || __nd= ;; *) __nd= ;; esac
  [ -n "$__nd" ] || __t_findnode || return 81
  "$__nd" "$__s/bin/tessel-shim.cjs" sessions "$1"
}
__t_ragent() {
  case $1 in ''|*[!0-9A-Za-z.-]*) return 90 ;; esac
  __s="$HOME/.tessel-server"
  [ -L "$__s" ] && return 98
  if [ -e "$__s" ]; then [ -d "$__s" ] && [ -O "$__s" ] || return 98; fi
  ( umask 077; mkdir -p "$__s" && mkdir -p "$__s/bin" "$__s/run" ) || return 98
  for __x in "$__s" "$__s/bin" "$__s/run"; do
    [ -L "$__x" ] && return 98
    [ -d "$__x" ] && [ -O "$__x" ] || return 98
    chmod 700 "$__x" || return 98
  done
  [ -L "$__s/bin/tessel-shim.cjs" ] && return 98
  __t_findnode || return 81
  __v=$("$__nd" -p 'process.versions.node.split(".")[0]' 2>/dev/null) || return 81
  [ "$__v" -ge 18 ] 2>/dev/null || return 82
  printf '%s\\n' "$__nd" >"$__s/bin/NODE"
  if [ ! -e "$HOME/.claude" ] && [ ! -e "$HOME/.claude.json" ]; then for __c in "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude; do [ -f "$__c" ] && [ -x "$__c" ] && { ( umask 077; mkdir -p "$HOME/.claude" ); break; }; done; fi
  if [ "$(cat "$__s/bin/VERSION" 2>/dev/null)" != "$1" ] || [ ! -f "$__s/bin/tessel-shim.cjs" ]; then
    __tmp=$(mktemp "$__s/bin/.shim.XXXXXX") || return 98
    __t_b64d <"$__T_D/u" >"$__tmp" || { rm -f "$__tmp"; return 98; }
    chmod 600 "$__tmp"
    mv -f "$__tmp" "$__s/bin/tessel-shim.cjs" || { rm -f "$__tmp"; return 98; }
    printf '%s\\n' "$1" >"$__s/bin/VERSION"
  fi
  "$__nd" "$__s/bin/tessel-shim.cjs" install --node "$__nd"
}
__t_paste() {
  case $1 in ''|*[!0-9a-z-]*) return 90 ;; esac
  __s="$HOME/.tessel-server"
  [ -L "$__s" ] && return 98
  if [ -e "$__s" ]; then [ -d "$__s" ] && [ -O "$__s" ] || return 98; fi
  ( umask 077; mkdir -p "$__s/paste" ) || return 98
  for __x in "$__s" "$__s/paste"; do
    [ -L "$__x" ] && return 98
    [ -d "$__x" ] && [ -O "$__x" ] || return 98
    chmod 700 "$__x" || return 98
  done
  find "$__s/paste" -type f -name 'image-*.png' -mmin +1440 -exec rm -f {} + 2>/dev/null
  __f="$__s/paste/image-$1.png"
  [ -e "$__f" ] || [ -L "$__f" ] && return 98
  ( umask 077; __t_b64d <"$__T_D/u" >"$__f" ) || { rm -f "$__f"; return 98; }
  printf '%s\\n' "$__f"
}
__t_tmo() {
  __ts=$1; shift
  rm -f "$__T_D/to" "$__T_D/tk"
  "$@" </dev/null >"$__T_D/to" 2>/dev/null &
  __tp=$!
  ( sleep "$__ts"; : >"$__T_D/tk"; __t_killtree "$__tp" ) </dev/null >/dev/null 2>&1 &
  __tw=$!
  wait "$__tp"; __tr=$?
  __t_killtree "$__tw"
  [ "$__tr" -gt 128 ] || rm -f "$__T_D/tk"
  cat "$__T_D/to" 2>/dev/null
  return "$__tr"
}
__t_loginpath() {
  __sh=\${SHELL:-/bin/sh}
  case \${__sh##*/} in
    fish) __t_tmo 6 "$__sh" -lc 'printf "@@TPATH@@%s@@TEND@@\\n" (string join : $PATH)' ;;
    csh|tcsh) __t_tmo 6 "$__sh" -c 'printf "@@TPATH@@%s@@TEND@@\\n" "$PATH"' ;;
    *) __t_tmo 6 "$__sh" -lc 'printf "@@TPATH@@%s@@TEND@@\\n" "$PATH"' ;;
  esac
}
__t_which() {
  __w=
  set -f
  __o=$IFS; IFS=:
  for __d in $__X; do
    case $__d in /*) ;; *) continue ;; esac
    if [ -f "$__d/$1" ] && [ -x "$__d/$1" ]; then __w="$__d/$1"; break; fi
  done
  IFS=$__o
  set +f
  [ -n "$__w" ]
}
__t_agents() {
  __part=
  __lp=$(__t_loginpath | sed -n 's/^.*@@TPATH@@\\(.*\\)@@TEND@@.*$/\\1/p' | tail -n 1) || __lp=
  [ -e "$__T_D/tk" ] && __part="$__part login"
  __nv=
  for __c in "$HOME"/.nvm/versions/node/*/bin; do [ -d "$__c" ] && __nv="$__c:$__nv"; done
  __X="$PATH:$__lp:$HOME/.local/bin:$HOME/bin:$HOME/.npm-global/bin:$HOME/.npm-packages/bin:$HOME/.volta/bin:$HOME/.bun/bin:$HOME/.yarn/bin:$HOME/.local/share/pnpm:$HOME/.cargo/bin:$HOME/.opencode/bin:$HOME/.grok/bin:$__nv:/snap/bin:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:/home/linuxbrew/.linuxbrew/bin"
  if __t_which npm; then
    __npm=$__w
    __pf=$(__t_tmo 8 env PATH="\${__npm%/*}:$PATH" "$__npm" --no-update-notifier config get prefix | tail -n 1) || __pf=
    [ -e "$__T_D/tk" ] && __part="$__part npm"
    case $__pf in /*) __X="$__X:$__pf/bin" ;; *) __pf= ;; esac
  else
    __npm=; __pf=
  fi
  [ $# -gt 0 ] || set -- claude codex
  # codex.known.<version>.nd<0|1>: what Tessel already knows of this host's
  # Codex (that version takes --no-daemon or not): its --help is not asked again.
  __ckv=; __ckn=
  for __a in "$@"; do
    case $__a in codex.known.*.nd[01]) __ckv=\${__a#codex.known.}; __ckn=\${__ckv##*.nd}; __ckv=\${__ckv%.nd*} ;; esac
  done
  __cx=
  for __a in "$@"; do
    case $__a in ''|[-.]*|*[!0-9A-Za-z._+-]*|codex.known.*) continue ;; esac
    if __t_which "$__a"; then __p=$__w
    elif [ -f "$HOME/.$__a/bin/$__a" ] && [ -x "$HOME/.$__a/bin/$__a" ]; then __p="$HOME/.$__a/bin/$__a"
    else __p=-; fi
    printf '%s %s\\n' "$__a" "$__p"
    [ "$__a" = codex ] && [ "$__p" != - ] && __cx=$__p
  done
  # The Codex found: its version, and whether its --help has --no-daemon
  # (Codex 0.156+), 2 s each at most; out of time: "@partial codex" (not
  # known, the rest of the answer whole). Neither starts its daemon nor
  # writes in ~/.codex (checked with Codex 0.150 and 0.164).
  if [ -n "$__cx" ]; then
    __v=$(__t_tmo 2 env PATH="\${__cx%/*}:$PATH" "$__cx" --version | tail -n 1) || __v=
    if [ -e "$__T_D/tk" ]; then
      __part="$__part codex"
    else
      __v=\${__v##* }
      case $__v in [0-9]*.[0-9]*) case $__v in *[!0-9A-Za-z.+-]*) __v= ;; esac ;; *) __v= ;; esac
      [ -z "$__v" ] || printf '@codexv %s\\n' "$__v"
      if [ -n "$__v" ] && [ "$__v" = "$__ckv" ]; then
        printf '@codexnd %s\\n' "$__ckn"
      else
        __h=$(__t_tmo 2 env PATH="\${__cx%/*}:$PATH" "$__cx" --help); __hr=$?
        if [ -e "$__T_D/tk" ]; then __part="$__part codex"
        elif [ "$__hr" -eq 0 ]; then
          case $__h in *--no-daemon*) printf '@codexnd 1\\n' ;; *) printf '@codexnd 0\\n' ;; esac
        fi
      fi
    fi
  fi
  __p=$(for __c in "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude; do [ -f "$__c" ] && [ -x "$__c" ] && printf '%s\\n' "$__c"; done | awk '{ v = $0; sub(/.*\\/anthropic\\.claude-code-/, "", v); sub(/\\/.*/, "", v); n = split(v, a, /[.-]/); k = ""; for (i = 1; i <= 4; i++) k = k sprintf("%09d", (i <= n && a[i] ~ /^[0-9]+$/) ? a[i] : 0); if (p == "" || k > b) { b = k; p = $0 } } END { print p }')
  [ -n "$__p" ] || __p=-
  printf 'vscode-claude %s\\n' "$__p"
  if __t_which node; then __nd=$__w; else __nd=-; fi
  printf '@node %s\\n' "$__nd"
  if [ "$__nd" != - ]; then __v=$(__t_tmo 8 "$__nd" -v | tail -n 1) || __v=; case $__v in v[0-9]*) printf '@nodev %s\\n' "\${__v#v}" ;; esac; fi
  printf '@npm %s\\n' "\${__npm:--}"
  if [ -n "$__pf" ]; then
    __pw=0
    if [ -d "$__pf/lib/node_modules" ]; then [ -w "$__pf/lib/node_modules" ] && __pw=1; else [ -w "$__pf" ] && __pw=1; fi
    [ -d "$__pf/bin" ] && [ ! -w "$__pf/bin" ] && __pw=0
    printf '@prefix %s\\n@prefixw %s\\n' "$__pf" "$__pw"
  fi
  for __c in snap curl wget; do if __t_which "$__c"; then __p=$__w; else __p=-; fi; printf '@%s %s\\n' "$__c" "$__p"; done
  printf '@uid %s\\n@os %s\\n' "$(id -u 2>/dev/null)" "$(uname -s 2>/dev/null)"
  [ -z "$__part" ] || printf '@partial%s\\n' "$__part"
}
__t_tfile() {
  case $2 in ''|*[!0-9A-Za-z-]*) return 90 ;; esac
  __F=
  case $1 in
    claude)
      for __c in "\${CLAUDE_CONFIG_DIR:-$HOME/.claude}"/projects/*/"$2".jsonl "$HOME"/.tessel-server/accounts/claude/*/projects/*/"$2".jsonl; do [ -f "$__c" ] && [ ! -L "$__c" ] && { __F=$__c; break; }; done ;;
    codex)
      __cd="\${CODEX_HOME:-$HOME/.codex}"
      case $3 in ''|*[!0-9/:]*) ;; *)
        __go=$IFS; IFS=:
        for __r in "$__cd/sessions" "$HOME"/.tessel-server/accounts/codex/*/sessions; do
          for __dd in $3; do
            for __c in "$__r/$__dd"/rollout-*"$2".jsonl; do [ -f "$__c" ] && [ ! -L "$__c" ] && { __F=$__c; break 3; }; done
          done
        done
        IFS=$__go ;;
      esac
      [ -n "$__F" ] || for __r in "$__cd/sessions" "$__cd/archived_sessions" "$HOME"/.tessel-server/accounts/codex/*/sessions; do
        [ -d "$__r" ] || continue
        __F=$(find "$__r" -type f -name "rollout-*$2.jsonl" 2>/dev/null | head -n 1)
        [ -n "$__F" ] && break
      done ;;
    *) return 90 ;;
  esac
  [ -n "$__F" ] && [ -f "$__F" ] || return 91
}
__t_twin() {
  case $2 in -|''|*[!0-9]*) [ "$2" = - ] || return 90 ;; esac
  case $3 in ''|*[!0-9]*) return 90 ;; esac
  __s=$(__t_sig "$1") || return 91
  __z=\${__s%% *}
  __m=\${__s#* }; __m=\${__m%% *}
  printf '%s %s\\n' "$__z" "$__m"
  if [ "$2" = - ]; then
    if [ "$__z" -gt "$3" ]; then tail -c "$3" "$1"; else cat "$1"; fi
  elif [ "$2" -lt "$__z" ]; then
    tail -c +"$(($2+1))" "$1" | head -c "$3"
  fi
}
__t_tread() {
  __t_tfile "$1" "$2" "$5" || return $?
  __t_twin "$__F" "$3" "$4"
}
__t_subdir() {
  __t_tfile claude "$1" || return $?
  __SD=\${__F%.jsonl}
  [ -d "$__SD" ] && [ ! -L "$__SD" ] || return 92
  __SD=$__SD/subagents
  [ -d "$__SD" ] && [ ! -L "$__SD" ] || return 92
}
__t_subs() {
  case $2 in ''|*[!0-9]*) return 90 ;; esac
  __t_subdir "$1"; __r=$?
  [ "$__r" = 92 ] && return 0
  [ "$__r" = 0 ] || return $__r
  __n=0
  command ls -t "$__SD" 2>/dev/null | while IFS= read -r __b; do
    [ "$__n" -lt "$2" ] || break
    case $__b in .*|*[!0-9A-Za-z_.-]*) continue ;; *.jsonl) ;; *) continue ;; esac
    __c=$__SD/$__b
    [ -f "$__c" ] && [ ! -L "$__c" ] || continue
    __s=$(__t_sig "$__c") || continue
    __z=\${__s%% *}
    __m=\${__s#* }; __m=\${__m%% *}
    printf '%s %s %s\\n' "$__z" "$__m" "$__b"
    __n=$((__n+1))
  done
}
__t_smeta() {
  __t_subdir "$1"; __r=$?
  [ "$__r" = 92 ] && return 0
  [ "$__r" = 0 ] || return $__r
  shift
  for __b in "$@"; do
    case $__b in .*|*[!0-9A-Za-z_.-]*|'') continue ;; esac
    __c=$__SD/$__b.meta.json
    [ -f "$__c" ] && [ ! -L "$__c" ] || continue
    printf '@@M %s ' "$__b"; head -c 4096 "$__c" | __t_b64e | tr -d '\\n'; printf '\\n'
  done
}
__t_cxkids() {
  case $1 in ''|*[!0-9A-Za-z-]*) return 90 ;; esac
  case $2 in ''|*[!0-9]*) return 90 ;; esac
  __cd="\${CODEX_HOME:-$HOME/.codex}"
  for __r in "$__cd/sessions" "$HOME"/.tessel-server/accounts/codex/*/sessions; do
    [ -d "$__r" ] && [ ! -L "$__r" ] || continue
    find "$__r" -type f -name 'rollout-*.jsonl' -mtime -2 2>/dev/null | head -n 3000 | while IFS= read -r __c; do
      __b=\${__c##*/}
      case $__b in *"$1".jsonl|*[!0-9A-Za-z_.-]*) continue ;; esac
      [ -f "$__c" ] && [ ! -L "$__c" ] || continue
      head -c 262144 "$__c" | head -n 1 | grep -q -F -e "$1" || continue
      __s=$(__t_sig "$__c") || continue
      __z=\${__s%% *}
      __m=\${__s#* }; __m=\${__m%% *}
      printf '%s %s %s\\n' "$__z" "$__m" "$__b"
    done
  done | head -n "$2"
}
__t_sread() {
  case $2 in .*|*[!0-9A-Za-z_.-]*|'') return 90 ;; *.jsonl) ;; *) return 90 ;; esac
  __t_subdir "$1" || return 91
  [ -f "$__SD/$2" ] && [ ! -L "$__SD/$2" ] || return 91
  __t_twin "$__SD/$2" "$3" "$4"
}
__t_home() { printf '%s\\n' "$HOME"; }
__t_skills() {
  case $2 in ''|*[!0-9]*) return 90 ;; esac
  __h="$HOME/.claude"
  for __k in home repo; do
    if [ "$__k" = home ]; then __b=$__h; else
      [ "$1" = - ] && continue
      [ -d "$1" ] || continue
      __b="\${1%/}/.claude"
      [ "$__b" = "$__h" ] && continue
    fi
    [ -d "$__b" ] && [ ! -L "$__b" ] && [ -d "$__b/skills" ] && [ ! -L "$__b/skills" ] || continue
    find "$__b/skills" -maxdepth 4 -type f -name SKILL.md 2>/dev/null | head -n "$2" | while IFS= read -r __f; do
      [ -f "$__f" ] && [ ! -L "$__f" ] || continue
      printf '@@S %s ' "$__k"; printf '%s' "$__f" | __t_b64e | tr -d '\\n'; printf '\\n'
      head -c 8192 "$__f" | __t_b64e | tr -d '\\n'; printf '\\n'
    done
  done
}
__t_nolink() {
  __p=$1
  [ -d "$__p" ] || return 1
  for __s in $(printf '%s' "$2" | tr '/' ' '); do __p=$__p/$__s; [ -d "$__p" ] && [ ! -L "$__p" ] || return 1; done
}
__t_skls() {
  [ -d "$2" ] && [ ! -L "$2" ] || return 0
  __o=$(printf '%s' "$2" | __t_b64e | tr -d '\\n')
  find "$2" -maxdepth 4 -type f -name SKILL.md 2>/dev/null | head -n "$3" | while IFS= read -r __f; do
    [ -f "$__f" ] && [ ! -L "$__f" ] || continue
    printf '@@S %s %s ' "$1" "$__o"; printf '%s' "$__f" | __t_b64e | tr -d '\\n'; printf '\\n'
    head -c 8192 "$__f" | __t_b64e | tr -d '\\n'; printf '\\n'
  done
}
__t_cxskills() {
  case $2 in ''|*[!0-9]*) return 90 ;; esac
  __cx=\${CODEX_HOME:-$HOME/.codex}
  [ "$__cx" = / ] || __cx=\${__cx%/}
  [ -L "$__cx" ] || { __t_nolink "$__cx" skills && __t_skls home "$__cx/skills" "$2"; }
  __t_nolink "$HOME" .agents/skills && __t_skls home "$HOME/.agents/skills" "$2"
  if [ "$1" != - ] && [ -d "$1" ]; then
    __pr=\${1%/}
    for __k in .agents/skills .codex/skills; do
      [ "$__pr/$__k" = "$HOME/.agents/skills" ] && continue
      [ "$__pr/$__k" = "$__cx/skills" ] && continue
      __t_nolink "$__pr" "$__k" && __t_skls repo "$__pr/$__k" "$2"
    done
  fi
  return 0
}
${ACCOUNTS_SHELL}
if [ -z "$__T_B" ]; then printf '\\n@@R %s base64\\n' "$__T_N"; else printf '\\n@@R %s ok\\n' "$__T_N"; fi
`
}

// The ssh.exe argv for a session on a host: launchArgs is remoteHosts'
// argv (its options, then the destination); batch: no askpass available, so
// ssh may not ask anything (keys or an agent only).
export function sessionArgs(launchArgs, { batch = false } = {}) {
  return [
    '-T',
    '-o', 'RequestTTY=no',
    '-o', 'RemoteCommand=none',
    '-o', 'ClearAllForwardings=yes',
    '-o', 'ConnectTimeout=20',
    '-o', 'ServerAliveInterval=15',
    '-o', 'ServerAliveCountMax=3',
    // Files and git need none of these (the terminals keep the user's own).
    '-o', 'ForwardAgent=no',
    '-o', 'ForwardX11=no',
    '-o', 'PermitLocalCommand=no',
    ...(batch ? ['-o', 'BatchMode=yes'] : []),
    ...launchArgs,
    'exec /bin/sh'
  ]
}

function uploadLines(buf) {
  const b64 = Buffer.from(buf).toString('base64')
  const lines = ['__t_up']
  for (let i = 0; i < b64.length; i += UPLOAD_LINE) lines.push(`printf '%s\\n' '${b64.slice(i, i + UPLOAD_LINE)}' >>"$__T_D/u"`)
  return lines
}

// One request line (and the upload before it).
export function requestScript(id, cap, fn, args = [], upload = null, seconds = 30) {
  if (!FUNCTIONS.has(fn)) throw new Error('unknown remote function') // i18n-ignore internal
  if (!Number.isInteger(id) || id < 1 || !Number.isInteger(cap) || cap < 1 || !Number.isInteger(seconds) || seconds < 1) throw new Error('bad request') // i18n-ignore internal
  const parts = args.map((a) => (isRawArg(a) ? a[RAW] : sq(a)))
  const lines = upload ? uploadLines(upload) : []
  lines.push(`__t_q ${id} ${cap} ${seconds} ${fn}${parts.length ? ' ' + parts.join(' ') : ''}`)
  return lines.join('\n') + '\n'
}

// A session: start() once, then run() requests (queued, one at a time).
// file / args: ssh.exe and sessionArgs(); env: its environment (askpass).
export function createRemoteSession({
  file,
  args,
  env,
  spawnImpl = spawn,
  timers = { setTimeout, clearTimeout },
  readyTimeoutMs = READY_TIMEOUT_MS,
  maxResponse = MAX_RESPONSE,
  randomHex = () => crypto.randomBytes(16).toString('hex'),
  onExit = () => {},
  // This session's own queue bounds (a guest's lane keeps a small one) and
  // default wait for a turn (null: the module's).
  maxQueued = MAX_QUEUED,
  maxBgQueued = MAX_BG_QUEUED,
  queueWait = null,
  // Told of a request that waited or ran for slowMs or more, and of one given
  // up as busy, with what ran and what waited (the log line that says what
  // held a host's session): ({ kind: 'slow' | 'busy', fn, waitMs, runMs?,
  // rc?, why?, running?, waiting, queued }).
  onSlow = null,
  slowMs = SLOW_REPORT_MS,
  clock = () => Date.now()
} = {}) {
  const nonce = randomHex()
  let child = null
  let state = 'new' // new | starting | ready | closed
  let readyWait = null
  let stderrTail = ''
  let exitCode = null
  let seq = 0
  const queue = [] // waiting requests
  let current = null // { id, resolve, reject, timer, sections, section, size }
  let lineParts = []
  let lineSize = 0
  let closedReason = null
  let lastUsed = Date.now()

  const readyRe = new RegExp(`^@@R ${nonce} (\\S+)$`)
  const markRe = new RegExp(`^@@T ${nonce} (\\d+) (\\S+)$`)

  function fail(reason) {
    if (state === 'closed') return
    state = 'closed'
    closedReason = reason
    const err = sessionError(reason)
    if (readyWait) {
      timers.clearTimeout(readyWait.timer)
      readyWait.reject(err)
      readyWait = null
    }
    if (current) {
      timers.clearTimeout(current.timer)
      current.reject(err)
      current = null
    }
    while (queue.length) {
      const q = queue.shift()
      if (q.waitTimer) timers.clearTimeout(q.waitTimer)
      // Never sent to the host: the caller may run it on a new session.
      q.reject(Object.assign(sessionError(reason), { notSent: true }))
    }
    if (child) {
      try {
        child.stdin.end()
      } catch {
        /* gone */
      }
      try {
        child.kill()
      } catch {
        /* gone */
      }
    }
    try {
      onExit(reason)
    } catch {
      /* the owner is gone */
    }
  }

  function sessionError(reason) {
    const e = new Error(`remote session ${reason}`) // i18n-ignore internal: callers translate by code
    e.code = reason
    e.stderr = stderrTail.trim()
    e.exitCode = exitCode
    return e
  }

  function onLine(buf) {
    const text = buf.toString('latin1').replace(/\r$/, '')
    if (state === 'starting') {
      const m = readyRe.exec(text)
      if (!m) return // login banners, rc file output: ignored
      if (m[1] !== 'ok') return fail(m[1] === 'base64' ? 'no-base64' : 'prelude')
      state = 'ready'
      if (readyWait) {
        timers.clearTimeout(readyWait.timer)
        readyWait.resolve()
        readyWait = null
      }
      pump()
      return
    }
    if (!current) return
    const m = markRe.exec(text)
    if (m && Number(m[1]) === current.id) {
      const tag = m[2]
      if (tag === 'e') current.section = 'err'
      else if (tag === 'z') finish()
      else if (/^\d+$/.test(tag)) {
        current.rc = Number(tag)
        current.section = 'out'
      }
      return
    }
    if (!current.section || !text) return
    current.size += text.length
    if (current.size > maxResponse) return fail('too-large')
    current[current.section].push(text)
  }

  function finish() {
    const c = current
    current = null
    timers.clearTimeout(c.timer)
    if (c.touch !== false) lastUsed = Date.now()
    const out = Buffer.from(c.out.join(''), 'base64')
    const err = Buffer.from(c.err.join(''), 'base64').toString('utf8')
    const at = clock()
    const runMs = at - c.startedAt
    const waitMs = c.startedAt - c.queuedAt
    if (runMs >= slowMs || waitMs >= slowMs) report({ kind: 'slow', fn: c.fn, waitMs, runMs, rc: c.rc })
    c.resolve({ rc: c.rc, out, err, truncated: out.length >= c.cap })
    pump()
  }

  // What waits in the queue, by function ("__t_tread x3, __t_agents").
  function queued() {
    const counts = new Map()
    for (const q of queue) counts.set(q.fn, (counts.get(q.fn) || 0) + 1)
    return [...counts].map(([fn, n]) => (n > 1 ? `${fn} x${n}` : fn)).join(', ')
  }
  function report(info) {
    if (typeof onSlow !== 'function') return
    try {
      onSlow({
        ...info,
        running: current ? { fn: current.fn, ms: clock() - current.startedAt } : null,
        waiting: queue.length,
        queued: queued()
      })
    } catch {
      /* only a log line */
    }
  }

  function onData(chunk) {
    let start = 0
    for (;;) {
      const nl = chunk.indexOf(0x0a, start)
      if (nl < 0) {
        const rest = chunk.subarray(start)
        lineSize += rest.length
        if (lineSize > maxResponse) return fail('too-large')
        if (rest.length) lineParts.push(rest)
        return
      }
      const piece = chunk.subarray(start, nl)
      const line = lineParts.length ? Buffer.concat([...lineParts, piece]) : piece
      lineParts = []
      lineSize = 0
      start = nl + 1
      onLine(line)
      if (state === 'closed') return
    }
  }

  function busyError() {
    const e = new Error('remote session busy') // i18n-ignore internal: callers translate by code
    e.code = 'busy'
    return e
  }

  function pump() {
    if (state !== 'ready' || current || !queue.length) return
    // The user's own requests first; background ones in the gaps.
    // Then the background ones that a pane waits for (first: the agent check
    // made when a terminal opens), before Live Share guests' reads and polls.
    // The Files panel's own git work (low: its colours, the Changes count)
    // last: it only starts when nothing else waits (agent readers, a pane's
    // account checks, the user's clicks go first).
    let at = queue.findIndex((r) => !r.bg)
    if (at < 0) at = queue.findIndex((r) => r.first)
    if (at < 0) at = queue.findIndex((r) => !r.low)
    if (at < 0) at = 0
    const [req] = queue.splice(at, 1)
    if (req.waitTimer) timers.clearTimeout(req.waitTimer)
    current = { ...req, out: [], err: [], section: null, size: 0, rc: null, startedAt: clock() }
    current.timer = timers.setTimeout(() => fail('timeout'), req.timeoutMs + HARD_MARGIN_MS)
    writeRequest(current)
  }

  // An upload (a file saved) goes in slices, the event loop free between
  // them: a 40 MB save is ~55 MB of base64 lines, which in one piece held
  // the main process for half a second. A pipe that pushes back (ssh.exe's
  // stdin) is waited for.
  function writeRequest(req) {
    const write = (text) => {
      try {
        return child.stdin.write(text)
      } catch {
        fail('closed')
        return null
      }
    }
    if (!req.upload) {
      write(req.script)
      return
    }
    const raw = (UPLOAD_LINE / 4) * 3 // bytes per base64 line (no padding inside)
    const step = UPLOAD_SLICE_LINES * raw
    let off = 0
    if (write('__t_up\n') === null) return
    const next = () => {
      if (state === 'closed' || current !== req) return
      if (off >= req.upload.length) {
        write(req.script)
        return
      }
      const end = Math.min(off + step, req.upload.length)
      const lines = []
      for (let i = off; i < end; i += raw) lines.push(`printf '%s\\n' '${req.upload.subarray(i, Math.min(i + raw, end)).toString('base64')}' >>"$__T_D/u"\n`)
      off = end
      const ok = write(lines.join(''))
      if (ok === null) return
      if (ok === false && typeof child.stdin.once === 'function') child.stdin.once('drain', () => setImmediate(next))
      else setImmediate(next)
    }
    next()
  }

  function start() {
    if (state !== 'new') return readyWait ? readyWait.promise : state === 'ready' ? Promise.resolve() : Promise.reject(sessionError(closedReason || 'closed'))
    state = 'starting'
    let resolve
    let reject
    const promise = new Promise((res, rej) => {
      resolve = res
      reject = rej
    })
    readyWait = { promise, resolve, reject, timer: timers.setTimeout(() => fail('connect-timeout'), readyTimeoutMs) }
    try {
      child = spawnImpl(file, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, env })
    } catch {
      fail('spawn')
      return promise
    }
    child.on('error', () => fail('spawn'))
    child.on('exit', (code) => {
      exitCode = code
      // An ssh2 channel (ssh/sshRemote.js) says why it could not start.
      fail(state === 'starting' ? child.failCode || 'connect' : 'closed')
    })
    if (child.stdin) child.stdin.on('error', () => {})
    child.stdout.on('data', onData)
    child.stderr.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString('utf8')).slice(-MAX_STDERR_TAIL)
    })
    try {
      child.stdin.write(prelude(nonce))
    } catch {
      fail('spawn')
    }
    return promise
  }

  // -> Promise<{ rc, out: Buffer, err: string, truncated }>; rejects with an
  // error whose code is the session's end (timeout, closed, cancelled…), or
  // 'busy' (waited too long for its turn, or too many waiting: the session
  // goes on). background: a poll or a reader, behind the user's requests.
  // signal: an AbortSignal; aborted while it waits, the request is dropped
  // (once it runs, only the session's end stops it).
  // low (with background): the Files panel's own git work, behind every
  // other background request too (see pump); its queue bound is its own.
  function run(fn, args = [], { cap = 4 * 1024 * 1024, timeoutMs = DEFAULT_TIMEOUT_MS, upload = null, touch = true, background = false, first = false, low = false, queueWaitMs, signal = null } = {}) {
    if (state === 'closed') return Promise.reject(sessionError(closedReason || 'closed'))
    if (signal && signal.aborted) return Promise.reject(Object.assign(new Error('cancelled'), { code: 'cancelled' })) // i18n-ignore internal
    const isLow = !!low && !!background && !first
    const waiting = queue.filter((q) => !!q.bg === !!background && !!q.low === isLow).length
    if (waiting >= (background ? maxBgQueued : maxQueued)) {
      report({ kind: 'busy', fn, why: 'full', waitMs: 0 })
      return Promise.reject(busyError())
    }
    let script
    const id = ++seq
    try {
      // The request line only: its upload is written in slices (writeRequest).
      script = requestScript(id, cap, fn, args, null, Math.max(1, Math.ceil(timeoutMs / 1000)))
    } catch (err) {
      return Promise.reject(Object.assign(new Error(err.message), { code: 'bad-argument' }))
    }
    const data = upload ? Buffer.from(upload) : null
    return new Promise((resolve, reject) => {
      const req = { id, fn, cap, script, upload: data, timeoutMs, touch, bg: !!background, first: !!first && !!background, low: isLow, resolve, reject, waitTimer: null, queuedAt: clock() }
      const drop = (err) => {
        const at = queue.indexOf(req)
        if (at < 0) return
        queue.splice(at, 1)
        if (req.waitTimer) timers.clearTimeout(req.waitTimer)
        reject(err)
      }
      queue.push(req)
      // Its turn has to come within the wait limit (counted from now, so
      // only while the session is up or starting).
      const wait =
        Number.isFinite(queueWaitMs) && queueWaitMs > 0
          ? queueWaitMs
          : Number.isFinite(queueWait) && queueWait > 0
            ? queueWait
            : first
              ? QUEUE_WAIT_MS
              : background
                ? BG_QUEUE_WAIT_MS
                : QUEUE_WAIT_MS
      const giveUp = () => {
        req.waitTimer = null
        const was = queue.includes(req)
        // Held only by the Files panel's git work (low work never starts
        // while this one waits, so the one running was there before it):
        // waits for it to end, once, bounded by that run's own limit,
        // instead of failing because of it.
        if (was && !req.low && !req.extended && current && current.low) {
          req.extended = true
          const left = current.timeoutMs + HARD_MARGIN_MS - (clock() - current.startedAt)
          req.waitTimer = timers.setTimeout(giveUp, Math.max(1000, left))
          return
        }
        drop(busyError())
        if (was) report({ kind: 'busy', fn, why: 'wait', waitMs: clock() - req.queuedAt })
      }
      req.waitTimer = timers.setTimeout(giveUp, wait)
      if (signal && typeof signal.addEventListener === 'function') {
        signal.addEventListener('abort', () => drop(Object.assign(new Error('cancelled'), { code: 'cancelled' })), { once: true }) // i18n-ignore internal
      }
      pump()
    })
  }

  return {
    start,
    run,
    close: (reason = 'cancelled') => fail(reason),
    get state() {
      return state
    },
    get busy() {
      return !!current || queue.length > 0
    },
    get pending() {
      return (current ? 1 : 0) + queue.length
    },
    get lastUsed() {
      return lastUsed
    },
    get stderr() {
      return stderrTail
    }
  }
}
