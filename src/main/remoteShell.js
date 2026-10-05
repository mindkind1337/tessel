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

export const READY_TIMEOUT_MS = 180_000 // a password question may wait 2 minutes
export const DEFAULT_TIMEOUT_MS = 30_000
// Past the host's own limit: the session itself is ended.
const HARD_MARGIN_MS = 15_000
export const MAX_RESPONSE = 96 * 1024 * 1024
const MAX_STDERR_TAIL = 4096
const UPLOAD_LINE = 16 * 1024

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
  '__t_stats',
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
  // parseAgentTools): their paths only.
  '__t_agents',
  // The agent sessions on this host (the shim's `sessions`): ids, folders,
  // titles, never their contents.
  '__t_rsess'
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
__t_git() { __g=$1; shift; LC_ALL=C LANGUAGE= GIT_TERMINAL_PROMPT=0 GIT_MERGE_AUTOEDIT=no GIT_EDITOR=: GIT_PAGER=cat PAGER=cat git -C "$__g" -c core.fsmonitor=false -c core.quotepath=off "$@"; }
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
__t_stats() {
  __t_root "$1" || return $?; shift
  for __f in "$@"; do
    if __p=$(__t_real "$__f") && [ -n "$__p" ] && __t_in "$__R" "$__p" && [ -f "$__p" ] && __s=$(__t_sig "$__p"); then printf '%s\\n' "$__s"; else printf '%s\\n' -; fi
  done
}
__t_read() {
  __t_tgt "$1" "$2" || return $?
  if [ ! -f "$__P" ]; then [ -d "$__P" ] && return 96; return 92; fi
  __s=$(__t_sig "$__P") || return 91
  [ "\${__s%% *}" -le "$3" ] || { printf '%s\\n' "$__s"; return 93; }
  cat "$__P" >"$__T_D/c" || return 98
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
  __t_root "$1" || return $?
  __E=
  if [ -e "$2" ] || [ -L "$2" ]; then
    __t_tgt "$1" "$2" || return $?
    [ -d "$__P" ] && return 96
    [ -f "$__P" ] || return 92
    __E=1
  else
    __t_ent "$1" "$2" || return $?
  fi
  __t_same "$__P" "$3" "$4" || { __t_sig "$__P"; return 95; }
  __tmp=$(mktemp "\${__P%/*}/.\${__P##*/}.tessel-XXXXXX") || return 98
  if ! __t_b64d <"$__T_D/u" >"$__tmp"; then rm -f "$__tmp"; return 98; fi
  if [ -n "$__E" ]; then __m=$(__t_sig "$__P"); __m=\${__m##* }; elif [ -n "$5" ]; then __m=$5; else __m=$(__t_newmode); fi
  chmod "$__m" "$__tmp" 2>/dev/null
  __t_same "$__P" "$3" "$4" || { rm -f "$__tmp"; __t_sig "$__P"; return 95; }
  mv -f "$__tmp" "$__P" || { rm -f "$__tmp"; return 98; }
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
    find "$__R/." \\( -name .git -o -name node_modules -o -name dist -o -name build -o -name out -o -name .next -o -name .cache -o -name target -o -name .venv -o -name __pycache__ \\) -prune -o -iname "$2" ! -type d -print0
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
  __x=$(find "$__R/." \\( -name node_modules -o -name dist -o -name build -o -name out -o -name .next -o -name .cache -o -name target -o -name .venv -o -name __pycache__ -o -path '*/.git/objects' -o -path '*/.git/logs' \\) -prune -o -newer "$__m" -print 2>/dev/null | head -n 1)
  mv -f "$__m.n" "$__m"
  if [ -n "$__x" ]; then echo changed; else echo same; fi
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
  if [ "$(cat "$__s/bin/VERSION" 2>/dev/null)" != "$1" ] || [ ! -f "$__s/bin/tessel-shim.cjs" ]; then
    __tmp=$(mktemp "$__s/bin/.shim.XXXXXX") || return 98
    __t_b64d <"$__T_D/u" >"$__tmp" || { rm -f "$__tmp"; return 98; }
    chmod 600 "$__tmp"
    mv -f "$__tmp" "$__s/bin/tessel-shim.cjs" || { rm -f "$__tmp"; return 98; }
    printf '%s\\n' "$1" >"$__s/bin/VERSION"
  fi
  "$__nd" "$__s/bin/tessel-shim.cjs" install --node "$__nd"
}
__t_agents() {
  for __a in claude codex; do
    __p=$(command -v "$__a" 2>/dev/null) || __p=
    case $__p in /*) ;; *) __p= ;; esac
    if [ -z "$__p" ]; then __p=$("\${SHELL:-/bin/sh}" -lc "command -v $__a" </dev/null 2>/dev/null | tail -n 1) || __p=; case $__p in /*) ;; *) __p= ;; esac; fi
    if [ -z "$__p" ]; then for __c in "$HOME/.local/bin/$__a" "$HOME/.npm-global/bin/$__a" "$HOME"/.nvm/versions/node/*/bin/"$__a"; do [ -f "$__c" ] && [ -x "$__c" ] && __p=$__c; done; fi
    [ -n "$__p" ] && [ -x "$__p" ] || __p=-
    printf '%s %s\\n' "$__a" "$__p"
  done
  __p=$(for __c in "$HOME"/.vscode-server/extensions/anthropic.claude-code-*/resources/native-binary/claude; do [ -f "$__c" ] && [ -x "$__c" ] && printf '%s\\n' "$__c"; done | awk '{ v = $0; sub(/.*\\/anthropic\\.claude-code-/, "", v); sub(/\\/.*/, "", v); n = split(v, a, /[.-]/); k = ""; for (i = 1; i <= 4; i++) k = k sprintf("%09d", (i <= n && a[i] ~ /^[0-9]+$/) ? a[i] : 0); if (p == "" || k > b) { b = k; p = $0 } } END { print p }')
  [ -n "$__p" ] || __p=-
  printf 'vscode-claude %s\\n' "$__p"
}
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
  onExit = () => {}
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
    while (queue.length) queue.shift().reject(err)
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
    c.resolve({ rc: c.rc, out, err, truncated: out.length >= c.cap })
    pump()
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

  function pump() {
    if (state !== 'ready' || current || !queue.length) return
    const req = queue.shift()
    current = { ...req, out: [], err: [], section: null, size: 0, rc: null }
    current.timer = timers.setTimeout(() => fail('timeout'), req.timeoutMs + HARD_MARGIN_MS)
    try {
      child.stdin.write(req.script)
    } catch {
      fail('closed')
    }
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
  // error whose code is the session's end (timeout, closed, cancelled…).
  function run(fn, args = [], { cap = 4 * 1024 * 1024, timeoutMs = DEFAULT_TIMEOUT_MS, upload = null, touch = true } = {}) {
    if (state === 'closed') return Promise.reject(sessionError(closedReason || 'closed'))
    let script
    const id = ++seq
    try {
      script = requestScript(id, cap, fn, args, upload, Math.max(1, Math.ceil(timeoutMs / 1000)))
    } catch (err) {
      return Promise.reject(Object.assign(new Error(err.message), { code: 'bad-argument' }))
    }
    return new Promise((resolve, reject) => {
      queue.push({ id, cap, script, timeoutMs, touch, resolve, reject })
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
