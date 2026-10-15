/**
 * Remote watchdog: ensures a remote command dies as soon as the ssh channel
 * closes (ESC, timeout, local client dead, network/master gone).
 *
 * Without a PTY there is no SIGHUP on the remote at disconnect – the process
 * would keep running orphaned. The wrapper therefore starts the command in its
 * own process group (`set -m`) and has a watchdog listen on stdin:
 * EOF means "channel closed" → TERM to the whole group, KILL after GUARD_GRACE_S.
 * Locally, stdin must stay open for this; aborting = closing stdin.
 */

/** Seconds between TERM and KILL. */
export const GUARD_GRACE_S = 2;

/** POSIX-safe single quoting for the remote shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// $1 = command, $2 = "1": pass the first stdin line (sudo password) to the command.
// The watchdog reads fd 3 (otherwise, as a background job, it would get /dev/null)
// and ignores TERM after triggering, so that the wrapper exiting does not reap
// it before the KILL step; its output goes to /dev/null so it does not keep
// the channel open. Job messages from bash ("[1]- Terminated …", also without
// a TTY since bash 5.2) end up on the wrapper stderr → /dev/null; only the
// command gets the real stderr via fd 4.
const GUARD = `set -m
exec 3<&0 4>&2 2>/dev/null
if [ "$2" = 1 ]; then
  IFS= read -r pw
  ( printf '%s\\n' "$pw" | bash -c "$1" ) 2>&4 3<&- 4>&- &
  unset pw
else
  bash -c "$1" </dev/null 2>&4 3<&- 4>&- &
fi
pid=$!
( cat <&3 >/dev/null; exec 3<&-; trap '' TERM
  kill -TERM -- -$pid; sleep ${GUARD_GRACE_S}; kill -KILL -- -$pid ) </dev/null >/dev/null 2>&1 4>&- &
wd=$!
exec 3<&- 4>&-
wait $pid; rc=$?
kill -- -$wd 2>/dev/null
exit $rc`;

// Runs as root under sudo: the user watchdog cannot kill root processes,
// but sudo forwards its TERM/HUP to this wrapper, which then cleans up the
// root process group itself.
const ROOT_GUARD = `set -m
exec 4>&2 2>/dev/null
bash -c "$1" </dev/null 2>&4 4>&- &
pid=$!
trap 'kill -TERM -- -$pid
  ( sleep ${GUARD_GRACE_S}; kill -KILL -- -$pid ) </dev/null >/dev/null 2>&1 4>&- &
  exit 143' TERM HUP INT
wait $pid`;

/** Wraps `command` in the watchdog; `passLine`: the first stdin line goes to the command. */
export function guardCommand(command: string, passLine = false): string {
	return `bash -c ${shq(GUARD)} pi-guard ${shq(command)}${passLine ? " 1" : ""}`;
}

/** For `sudo … bash -c`: cleans up the root process group when sudo forwards TERM/HUP. */
export function rootGuardArgs(command: string): string {
	return `bash -c ${shq(ROOT_GUARD)} pi-guard ${shq(command)}`;
}
