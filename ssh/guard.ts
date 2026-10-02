/**
 * Remote-Watchdog: sorgt dafür, dass ein Remote-Befehl stirbt, sobald der
 * ssh-Kanal zugeht (ESC, Timeout, lokaler Client tot, Netz/Master weg).
 *
 * Ohne PTY gibt es remote kein SIGHUP beim Disconnect – der Prozess würde
 * verwaist weiterlaufen. Der Wrapper startet den Befehl deshalb in einer
 * eigenen Prozessgruppe (`set -m`) und lässt einen Watchdog auf stdin lauschen:
 * EOF heißt „Kanal zu“ → TERM an die ganze Gruppe, nach GUARD_GRACE_S KILL.
 * Lokal muss stdin dafür offen bleiben; abbrechen = stdin schließen.
 */

/** Sekunden zwischen TERM und KILL. */
export const GUARD_GRACE_S = 2;

/** POSIX-sicheres Single-Quoting für die Remote-Shell. */
export const shq = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;

// $1 = Befehl, $2 = "1": erste stdin-Zeile (sudo-Passwort) an den Befehl geben.
// Der Watchdog liest fd 3 (sonst bekäme er als Background-Job /dev/null) und
// ignoriert nach dem Auslösen TERM, damit ihn das Wrapper-Ende nicht vor dem
// KILL-Schritt abräumt; seine Ausgaben gehen nach /dev/null, damit er den
// Kanal nicht offen hält.
const GUARD = `set -m
exec 3<&0
if [ "$2" = 1 ]; then
  IFS= read -r pw
  ( printf '%s\\n' "$pw" | bash -c "$1" ) 3<&- &
  unset pw
else
  bash -c "$1" </dev/null 3<&- &
fi
pid=$!
( cat <&3 >/dev/null; exec 3<&-; trap '' TERM
  kill -TERM -- -$pid; sleep ${GUARD_GRACE_S}; kill -KILL -- -$pid ) </dev/null >/dev/null 2>&1 &
wd=$!
exec 3<&-
wait $pid; rc=$?
kill -- -$wd 2>/dev/null
exit $rc`;

// Läuft als root unter sudo: der User-Watchdog kann root-Prozesse nicht
// killen, aber sudo reicht sein TERM/HUP an diesen Wrapper weiter, der die
// root-Prozessgruppe dann selbst abräumt.
const ROOT_GUARD = `set -m
bash -c "$1" </dev/null &
pid=$!
trap 'kill -TERM -- -$pid
  ( sleep ${GUARD_GRACE_S}; kill -KILL -- -$pid ) </dev/null >/dev/null 2>&1 &
  exit 143' TERM HUP INT
wait $pid`;

/** Hüllt `command` in den Watchdog; `passLine`: erste stdin-Zeile geht an den Befehl. */
export function guardCommand(command: string, passLine = false): string {
	return `bash -c ${shq(GUARD)} pi-guard ${shq(command)}${passLine ? " 1" : ""}`;
}

/** Für `sudo … bash -c`: räumt die root-Prozessgruppe ab, wenn sudo TERM/HUP weiterreicht. */
export function rootGuardArgs(command: string): string {
	return `bash -c ${shq(ROOT_GUARD)} pi-guard ${shq(command)}`;
}
