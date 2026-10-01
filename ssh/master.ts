// ---------------------------------------------------------------------------
// SSH ControlMaster / ControlPersist
//
// ED25519-SK (YubiKey/FIDO2) verlangt pro Authentifizierung PIN + Touch auf
// einem echten TTY. pi startet ssh aber als Subprozess mit gepipter stdio
// (kein TTY) → die Prompts hängen unsichtbar fest.
//
// Lösung: Beim Session-Start wird einmalig interaktiv ein ControlMaster
// etabliert (TUI anhalten, Terminal an `ssh -N -f -M` übergeben, User tippt
// PIN und berührt den YubiKey). Danach reiten alle spawnSsh-Aufrufe über den
// ControlMaster-Socket (ControlMaster=auto) und müssen nicht erneut
// authentifizieren. ControlPersist hält den Socket nach der letzten
// Verbindung noch SSH_CONTROL_PERSIST Sekunden am Leben.
// ---------------------------------------------------------------------------

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

let sshControlSocket: string | null = null;

export const SSH_CONTROL_PERSIST: number = (() => {
	const raw = process.env.SSH_CONTROL_PERSIST;
	if (raw === undefined) return 43200; // Default: 12 h
	const n = parseInt(raw, 10);
	return Number.isFinite(n) && n >= 0 ? n : 43200;
})();

/** Setzt den aktiven ControlMaster-Socket (von der interaktiven Priming-Routine). */
export function setControlSocket(socket: string | null): void {
	sshControlSocket = socket;
	// Cache invalidieren: ein neuer/kein Socket bedeutet neue Realität.
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

/** Prüft, ob ein ControlMaster am gegebenen Socket lebt (`ssh -O check`). */
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
 * Echter End-to-End-Roundtrip durch den Socket. `ssh -O check` akzeptiert auch
 * Zombie-Master: der Prozess lebt und meldet „Master running“, obwohl die
 * darunterliegende Verbindung tot ist – jeder Session-Request stirbt dann mit
 * „read from master failed: Broken pipe“. Ein `true` durch den Mux-Socket ist
 * der einzige zuverlässige Lebensnachweis.
 */
export function canRoundTrip(socket: string, remote: string): boolean {
	try {
		const r = spawnSync(
			"ssh",
			[
				"-o",
				`ControlPath=${socket}`,
				"-o",
				"ControlMaster=no", // nie selbst in einen Verbindungsversuch fallen
				"-o",
				"BatchMode=yes", // kein Prompt – nur der bestehende Socket zählt
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

/** Räumt einen (mutmaßlich toten) Master auf: sauber beenden, Socket entfernen. */
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

/** SSH-Argumente für Remote-Kommandos: über den ControlMaster reiten, sobald gesetzt. */
export function sshCommandArgs(remote: string): string[] {
	if (!sshControlSocket) return [remote];
	// ControlMaster=no (statt auto): ein toter Socket schlägt SOFORT und erkennbar
	// fehl (broken pipe / connect failed), statt still in einen neuen Verbindungsversuch
	// zu fallen, der ohne TTY die YubiKey-PIN nicht abfragen kann.
	return ["-o", `ControlPath=${sshControlSocket}`, "-o", "ControlMaster=no", remote];
}

/** Symptome eines toten/Zombie-ControlMasters in ssh-Ausgabe. */
export const DEAD_MASTER =
	/read from master failed|Broken pipe|Control socket connect\([^)]*\): (No such file or directory|Connection refused)/i;

// Kurzzeit-Cache für isMasterAlive (spart pro Tool-Call einen `ssh -O check`).
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

/** Setzt den Socket-Zustand zurück, wenn der Master gestorben ist. */
export function invalidateMaster(): void {
	sshControlSocket = null;
	masterCheckKey = "";
	masterCheckAt = 0;
	masterCheckAlive = false;
}
