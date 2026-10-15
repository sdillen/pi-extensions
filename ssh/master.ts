// ---------------------------------------------------------------------------
// SSH ControlMaster / ControlPersist
//
// ED25519-SK (YubiKey/FIDO2) requires PIN + touch on a real TTY for each
// authentication. pi, however, starts ssh as a subprocess with piped stdio
// (no TTY) → the prompts hang invisibly.
//
// Solution: at session start, a ControlMaster is established once
// interactively (suspend the TUI, hand the terminal to `ssh -N -f -M`, the
// user types the PIN and touches the YubiKey). After that, all spawnSsh calls
// ride on the ControlMaster socket (ControlMaster=auto) and do not need to
// authenticate again. ControlPersist keeps the socket alive for
// SSH_CONTROL_PERSIST more seconds after the last connection.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let sshControlSocket: string | null = null;

export const SSH_CONTROL_PERSIST: number = (() => {
	const raw = process.env.SSH_CONTROL_PERSIST;
	if (raw === undefined) return 43200; // default: 12 h
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : 43200;
})();

/** Sets the active ControlMaster socket (from the interactive priming routine). */
export function setControlSocket(socket: string | null): void {
	sshControlSocket = socket;
	// Invalidate cache: a new/no socket means a new reality.
	masterCheckKey = "";
	masterCheckAt = 0;
	masterCheckAlive = false;
}

export function getControlSocket(): string | null {
	return sshControlSocket;
}

export function socketPathFor(remote: string): string {
	const safe = remote.replace(/[^A-Za-z0-9@:._-]/g, "_");
	return path.join(os.homedir(), ".ssh", "controlmaster", `${safe}.sock`);
}

/** Checks whether a ControlMaster is alive at the given socket (`ssh -O check`). */
export function isSocketAlive(socket: string, remote: string): boolean {
	try {
		const r = spawnSync(
			"ssh",
			["-o", `ControlPath=${socket}`, "-o", "ConnectTimeout=1", "-O", "check", remote],
			{ timeout: 3000 },
		);
		return r.status === 0;
	} catch {
		return false;
	}
}

/**
 * Real end-to-end roundtrip through the socket. `ssh -O check` also accepts
 * zombie masters: the process is alive and reports "Master running" although
 * the underlying connection is dead – every session request then dies with
 * "read from master failed: Broken pipe". A `true` through the mux socket is
 * the only reliable proof of life.
 */
export function canRoundTrip(socket: string, remote: string): boolean {
	try {
		const r = spawnSync(
			"ssh",
			[
				"-o",
				`ControlPath=${socket}`,
				"-o",
				"ControlMaster=no", // never fall into a connection attempt on our own
				"-o",
				"BatchMode=yes", // no prompt – only the existing socket counts
				"-o",
				"ConnectTimeout=3",
				remote,
				"true",
			],
			{ timeout: 5000 },
		);
		return r.status === 0;
	} catch {
		return false;
	}
}

/** Cleans up a (presumably dead) master: exit cleanly, remove the socket. */
export function cleanupMaster(socket: string, remote: string): void {
	try {
		spawnSync(
			"ssh",
			["-o", `ControlPath=${socket}`, "-o", "ConnectTimeout=2", "-O", "exit", remote],
			{
				timeout: 2000,
			},
		);
	} catch {
		/* ignore */
	}
	try {
		fs.rmSync(socket, { force: true });
	} catch {
		/* ignore */
	}
}

/** SSH arguments for remote commands: ride on the ControlMaster once set. */
export function sshCommandArgs(remote: string): string[] {
	if (!sshControlSocket) return [remote];
	// ControlMaster=no (instead of auto): a dead socket fails IMMEDIATELY and
	// recognizably (broken pipe / connect failed), instead of silently falling
	// into a new connection attempt, which cannot ask for the YubiKey PIN without a TTY.
	return ["-o", `ControlPath=${sshControlSocket}`, "-o", "ControlMaster=no", remote];
}

/** Symptoms of a dead/zombie ControlMaster in ssh output. */
export const DEAD_MASTER =
	/read from master failed|Broken pipe|Control socket connect\([^)]*\): (No such file or directory|Connection refused)/i;

// Short-lived cache for isMasterAlive (saves one `ssh -O check` per tool call).
let masterCheckKey = "";
let masterCheckAt = 0;
let masterCheckAlive = false;
const MASTER_CHECK_TTL_MS = 2000;

export function isMasterAlive(remote: string): boolean {
	const key = sshControlSocket ?? "";
	const now = Date.now();
	if (key !== masterCheckKey || now - masterCheckAt >= MASTER_CHECK_TTL_MS) {
		masterCheckKey = key;
		masterCheckAt = now;
		masterCheckAlive = key !== "" && isSocketAlive(key, remote);
	}
	return masterCheckAlive;
}

/** Resets the socket state when the master has died. */
export function invalidateMaster(): void {
	sshControlSocket = null;
	masterCheckKey = "";
	masterCheckAt = 0;
	masterCheckAlive = false;
}
