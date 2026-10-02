/**
 * SSH Remote Execution + sudo password prompt
 *
 * Erweitert das offizielle examples/extensions/ssh.ts:
 *  - alle Built-in-Tools (read/write/edit/bash) laufen auf dem Remote
 *  - `!`-Kommandos laufen ebenfalls remote
 *  - eigenes `sudo`-Tool (nur mit --ssh aktiv): führt den Befehl per
 *    `sudo bash -c` als root aus; das bash-Tool lehnt sudo remote ab und
 *    verweist darauf. `!`-Kommandos mit sudo werden weiter umgeschrieben.
 *  - zeigt für sudo ein maskiertes Dialogfenster (ctx.ui.custom),
 *    in dem du das sudo-Passwort eingibst – Zeichen werden als * gerendert
 *  - das Passwort wird nur im Extension-Speicher gehalten (nie im
 *    LLM-Context oder in der Session-Datei) und per `sudo -S` über
 *    stdin an den Remote gefüttert; nach SUDO_TTL_MS wird neu gefragt
 *  - bei falschem Passwort wird einmal neu nachgefragt
 *  - einmalige interaktive SSH-Authentifizierung beim Session-Start für
 *    ED25519-SK / YubiKey (PIN eingeben + berühren): die TUI wird angehalten,
 *    das Terminal an `ssh -N -f -M` übergeben, und erst nach erfolgreicher
 *    Authentifizierung läuft die Session. Danach reiten ALLE Remote-Aufrufe
 *    über einen ControlMaster-Socket (`~/.ssh/controlmaster/…`) und fragen
 *    nicht erneut. Steuerung: `SSH_CONTROL_PERSIST` (Sekunden, Default 43200).
 *
 * Usage (aus diesem Repo):
 *   pi -e ./ssh --ssh user@host
 *   pi -e ./ssh --ssh user@host:/remote/path
 * Oder die deployte Kopie in ~/.pi/agent/extensions/ssh/ (auto-discovered).
 *
 * Requirements:
 *   - bash on remote
 *   - SSH-Schlüssel erreichbar. ED25519-SK/YubiKey wird beim Start einmalig
 *     interaktiv bestätigt (PIN + Touch) statt pro Tool-Call.
 */

import type { ChildProcess } from "node:child_process";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
	BashOperations,
	BashToolInput,
	EditOperations,
	ExtensionAPI,
	ExtensionContext,
	ReadOperations,
	WriteOperations,
} from "@earendil-works/pi-coding-agent";
import {
	createBashTool,
	createBashToolDefinition,
	createEditTool,
	createReadTool,
	createWriteTool,
} from "@earendil-works/pi-coding-agent";
import type { Component, Focusable, Text } from "@earendil-works/pi-tui";
import { CURSOR_MARKER, getKeybindings } from "@earendil-works/pi-tui";
import { GUARD_GRACE_S, guardCommand, rootGuardArgs } from "./guard.ts";
import {
	canRoundTrip,
	cleanupMaster,
	DEAD_MASTER,
	getControlSocket,
	invalidateMaster,
	isMasterAlive,
	isSocketAlive,
	SSH_CONTROL_PERSIST,
	setControlSocket,
	socketPathFor,
	sshCommandArgs,
} from "./master.ts";
import {
	forgetSudo,
	getSudoPass,
	injectSudoStdin,
	isSudoFresh,
	rememberSudo,
	usesSudo,
} from "./sudo.ts";

// ---------------------------------------------------------------------------

/**
 * Maskiertes Passwort-Eingabefenster für ctx.ui.custom().
 * - rendert nur `*` pro Zeichen, der Cursor bleibt als Reverse-Video sichtbar
 * - Rohwert verlässt die Komponente ausschließlich über `done(value)`
 * - volle Bearbeitung: Backspace, Entf, Cursor, ctrl+u, ctrl+w, Paste
 */
class MaskedPasswordPrompt implements Component, Focusable {
	focused = false;
	private raw = "";
	private cursor = 0; // Index in [...raw]
	private readonly title: string;
	private readonly done: (value: string | undefined) => void;

	constructor(title: string, done: (value: string | undefined) => void) {
		this.title = title;
		this.done = done;
	}

	handleInput(data: string): void {
		const kb = getKeybindings();
		if (kb.matches(data, "tui.select.cancel")) {
			this.done(undefined);
			return;
		}
		if (kb.matches(data, "tui.input.submit") || data === "\n") {
			this.done(this.raw);
			return;
		}
		const chars = () => [...this.raw];
		if (kb.matches(data, "tui.editor.deleteCharBackward")) {
			const c = chars();
			if (this.cursor > 0 && c.length) {
				c.splice(this.cursor - 1, 1);
				this.raw = c.join("");
				this.cursor -= 1;
			}
			return;
		}
		if (kb.matches(data, "tui.editor.deleteCharForward")) {
			const c = chars();
			if (this.cursor < c.length) {
				c.splice(this.cursor, 1);
				this.raw = c.join("");
			}
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineStart")) {
			this.raw = "";
			this.cursor = 0;
			return;
		}
		if (kb.matches(data, "tui.editor.deleteToLineEnd")) {
			this.raw = this.raw.slice(0, this.cursor);
			return;
		}
		if (kb.matches(data, "tui.editor.deleteWordBackward")) {
			const c = chars();
			let i = this.cursor - 1;
			while (i >= 0 && /\s/.test(c[i])) i--;
			while (i >= 0 && !/\s/.test(c[i])) i--;
			c.splice(i + 1, this.cursor - (i + 1));
			this.raw = c.join("");
			this.cursor = i + 1;
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLeft")) {
			if (this.cursor > 0) this.cursor -= 1;
			return;
		}
		if (kb.matches(data, "tui.editor.cursorRight")) {
			if (this.cursor < chars().length) this.cursor += 1;
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineStart")) {
			this.cursor = 0;
			return;
		}
		if (kb.matches(data, "tui.editor.cursorLineEnd")) {
			this.cursor = chars().length;
			return;
		}
		if (
			kb.matches(data, "tui.editor.undo") ||
			kb.matches(data, "tui.editor.yank") ||
			kb.matches(data, "tui.editor.yankPop")
		) {
			return; // bewusst ignoriert
		}
		// druckbare Zeichen einfügen (Steuerzeichen ablehnen)
		const hasControl = [...data].some((ch) => {
			const code = ch.charCodeAt(0);
			return code < 32 || code === 0x7f || (code >= 0x80 && code <= 0x9f);
		});
		if (!hasControl) {
			const c = chars();
			c.splice(this.cursor, 0, data);
			this.raw = c.join("");
			this.cursor += [...data].length;
		}
	}

	invalidate(): void {
		// kein gecachtes Rendering – nichts zu tun
	}

	render(width: number): string[] {
		const frameW = Math.max(20, Math.min(60, width - 4));
		const inner = frameW - 2; // Innenbreite ohne Seitenrahmen
		const tr = (s: string, max: number) => {
			const dots = s.length > max ? "…" : "";
			return s.slice(0, Math.max(0, max - dots.length)) + dots;
		};

		// maskierte Zeile mit horizontalem Scrollen + Fake-Cursor (wie pi-Input)
		const prompt = "> ";
		const avail = Math.max(1, inner - 2);
		const mask = "*".repeat(this.raw.length);
		let visible = mask;
		let cursorCol = this.cursor;
		if (mask.length > avail - 1) {
			const start = mask.length - (avail - 1);
			visible = mask.slice(start);
			cursorCol = Math.max(0, this.cursor - start);
		}
		const visibleChars = [...visible];
		const atCursor = visibleChars[cursorCol] ?? " ";
		const before = visible.slice(0, cursorCol);
		const after = visible.slice(cursorCol + atCursor.length);
		const marker = this.focused ? CURSOR_MARKER : "";
		const content = before + marker + `\x1b[7m${atCursor}\x1b[27m` + after;
		const pad = " ".repeat(Math.max(0, avail - (prompt.length + visible.length)));
		const bodyLine = (prompt + content).slice(0, avail) + pad;

		const hint = "Enter = übernehmen · Esc = abbrechen";
		const top = `┌${"─".repeat(inner)}┐`;
		const bottom = `└${"─".repeat(inner)}┘`;
		const blank = `│${" ".repeat(inner)}│`;
		const titleLine = `│ ${tr(this.title, inner - 2).padEnd(inner - 2)} │`;
		const hintLine = `│ ${tr(hint, inner - 2).padEnd(inner - 2)} │`;
		const body = `│ ${bodyLine.slice(0, avail).padEnd(avail)} │`;
		return [top, titleLine, blank, body, blank, hintLine, bottom];
	}
}

// herdr-Integration (herdr-agent-state.ts) lauscht auf `herdr:blocked` und
// zeigt den Pane solange als „blocked“ an; ohne herdr verpufft das Event.
let emitEvent: ((name: string, data: unknown) => void) | undefined;

async function withBlocked<T>(label: string, fn: () => Promise<T>): Promise<T> {
	emitEvent?.("herdr:blocked", { active: true, label });
	try {
		return await fn();
	} finally {
		emitEvent?.("herdr:blocked", { active: false });
	}
}

/**
 * Fragt den User in einem maskierten Dialog nach dem sudo-Passwort.
 * Liefert undefined, wenn abgebrochen.
 */
async function promptSudoPassword(
	ctx: ExtensionContext,
	remote: string,
	reason: string,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("kein interaktives UI – sudo-Passwort kann nicht abgefragt werden", "error");
		return undefined;
	}
	const title = `sudo Passwort für ${remote}`;

	const pass = await withBlocked(title, async () => {
		if (ctx.mode === "tui") {
			// maskiertes Fenster via ctx.ui.custom (Editor wird kurz ersetzt)
			try {
				return await ctx.ui.custom<string | undefined>(
					(_tui, _theme, _kb, done) => new MaskedPasswordPrompt(title, done),
				);
			} catch {
				return undefined;
			}
		}
		// Fallback ohne TUI: unverdeckter Eingabedialog
		return ctx.ui.input(title, reason.startsWith("sudo") ? reason : undefined);
	});
	const trimmed = pass?.trim();
	if (!trimmed) return undefined;
	rememberSudo(trimmed);
	ctx.ui.setStatus(
		"sudo",
		ctx.ui.theme?.fg?.("accent", "sudo: Passwort übernommen") ?? "sudo: übernommen",
	);
	return trimmed;
}

const AUTH_TIMEOUT_MS = 120_000; // PIN + Touch müssen in 2 min klappen

/**
 * Etabliert einen ControlMaster interaktiv (PIN + Touch für ED25519-SK).
 * Hält die TUI an, übergibt das Terminal an `ssh -N -f -o ControlMaster=auto`
 * und wartet, bis die Authentifizierung durch ist (`ssh -f` kehrt erst danach
 * mit 0 zurück). Gibt true bei Erfolg zurück; der daemonisierte Master bleibt
 * per ControlPersist im Hintergrund erhalten. Mit `auto`: bei parallel
 * startenden Pi-Sessions wird genau EIN Master interaktiv etabliert; weitere
 * Sessions hängen sich beim Prime still an den Socket.
 */
async function primeControlMaster(ctx: ExtensionContext, remote: string): Promise<boolean> {
	const socket = socketPathFor(remote);
	fs.mkdirSync(path.dirname(socket), { recursive: true });

	// Bereits ein lebender Master (z. B. von einer früheren Session/ControlPersist)?
	// `ssh -O check` allein reicht NICHT: Zombies (Prozess lebt, Transport tot)
	// melden sich als „running“. Erst der echte Roundtrip durch den Socket beweist es.
	if (isSocketAlive(socket, remote)) {
		if (canRoundTrip(socket, remote)) {
			setControlSocket(socket);
			return true;
		}
		// Zombie-Master: aufräumen und unten frisch interaktiv authentifizieren.
		ctx.ui.notify(
			`SSH: alter Master für ${remote} war tot (Zombie) – neue Authentifizierung`,
			"info",
		);
	}
	// Stale Socket-Datei eines toten Masters entfernen, sonst weigert sich ssh.
	cleanupMaster(socket, remote);

	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(
			`SSH-Auth für ${remote} braucht ein interaktives Terminal (YubiKey PIN+Touch); Modus "${ctx.mode}" nicht geeignet`,
			"error",
		);
		return false;
	}

	ctx.ui.notify(`SSH: ${remote} – PIN eingeben, dann YubiKey berühren`, "info");

	const ok = await withBlocked(`SSH ${remote}: PIN + YubiKey`, () =>
		ctx.ui.custom<boolean>((tui, _theme, _kb, done) => {
			// TUI anhalten → Terminal (kanonischer Modus) an ssh übergeben
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			process.stdout.write(
				`\x1b[1m>> SSH-Authentifizierung für ${remote}\x1b[0m\n` +
					`PIN eingeben, dann YubiKey berühren. Die Pi-Session startet erst danach.\n` +
					`(Ctrl-C = abbrechen)\n\n`,
			);

			const child: ChildProcess = spawn(
				"ssh",
				[
					"-N", // keine Remote-Kommando → bleibt als Master verfügbar
					"-f", // nach erfolgreicher Auth in den Hintergrund (Return danach)
					"-o",
					"ControlMaster=auto", // Sieger wird Master; starten parallel weitere
					// Pi-Sessions, hängt sich der Verlierer still an den Socket (kein Re-Auth/Stray).
					"-S",
					socket,
					"-o",
					`ControlPersist=${SSH_CONTROL_PERSIST}`,
					remote,
				],
				{ stdio: "inherit", env: process.env },
			);

			let finished = false;
			const onSigint = () => child.kill("SIGINT");
			const authTimeout = setTimeout(() => {
				try {
					child.kill("SIGTERM");
				} catch {
					/* ignore */
				}
				finish(false);
			}, AUTH_TIMEOUT_MS);
			const finish = (success: boolean) => {
				if (finished) return;
				finished = true;
				process.removeListener("SIGINT", onSigint);
				clearTimeout(authTimeout);
				try {
					tui.start();
				} catch {
					/* ignore */
				}
				try {
					tui.requestRender(true);
				} catch {
					/* ignore */
				}
				done(success);
			};

			process.once("SIGINT", onSigint); // NUR hier: Ctrl-C bricht ab, tötet pi nicht
			child.on("error", () => finish(false));
			child.on("close", (code) => {
				// ssh -f kehrt erst NACH erfolgreicher Auth mit 0 zurück. Die
				// Socket-Anlage kann minimal nachlaufen → kurz nachpolln.
				if (code !== 0) {
					finish(false);
					return;
				}
				let tries = 0;
				const poll = setInterval(() => {
					tries += 1;
					if (isSocketAlive(socket, remote) || tries > 20) {
						clearInterval(poll);
						finish(isSocketAlive(socket, remote));
					}
				}, 50);
			});

			return { render: () => [], invalidate: () => {} };
		}),
	).catch(() => false);

	if (ok) {
		setControlSocket(socket);
	} else {
		ctx.ui.notify(`SSH-Authentifizierung für ${remote} fehlgeschlagen/abgebrochen`, "error");
	}
	return ok;
}

// ---------------------------------------------------------------------------
// SSH execution helpers
// ---------------------------------------------------------------------------

interface SshResult {
	exitCode: number;
	output: string;
}

/**
 * Wird nach session_start gesetzt, damit ein unterwegs gestorbener
 * ControlMaster automatisch interaktiv re-authentifiziert werden kann
 * (gleicher PIN+Touch-Dialog wie beim Start).
 */
let reprimeHook: ((remote: string) => Promise<boolean>) | undefined;

function deadMasterMessage(remote: string): string {
	return (
		`[ssh.ts] SSH-ControlMaster für ${remote} ist tot (Verbindung abgebrochen) – ` +
		"automatische Re-Authentifizierung fehlgeschlagen. Bitte YubiKey prüfen und " +
		`pi --ssh ${remote}` +
		" neu starten (oder den letzten ssh-Befehl wiederholen)."
	);
}

/** Setzt den Socket zurück und versucht einmalig, interaktiv neu zu authenticieren. */
async function recoverMaster(remote: string): Promise<boolean> {
	invalidateMaster();
	if (reprimeHook) return reprimeHook(remote);
	return false;
}

async function spawnSsh(
	remote: string,
	command: string,
	opts: {
		stdin?: string;
		onData?: (chunk: Buffer) => void;
		signal?: AbortSignal;
		timeout?: number; // Sekunden
	} = {},
): Promise<SshResult> {
	const run = async (attempt: number): Promise<SshResult> => {
		// Mehrmalige Wiederholung nach Recovery → klar abbrechen statt endlos zu retrien.
		if (attempt >= 2) {
			throw new Error(deadMasterMessage(remote));
		}

		// -O check (2-s-gecacht) meldet den Socket unerreichbar → Zombie/Stale.
		// Vor jedem echten Aufruf sicherstellen, dass der Master wirklich steht.
		if (getControlSocket() && !isMasterAlive(remote)) {
			if (await recoverMaster(remote)) return run(attempt + 1);
			throw new Error(deadMasterMessage(remote));
		}

		const res = await execOnce();

		// Der laufende Aufruf ist über einen toten Master gestolpert (z. B. Prozess
		// lebte noch für `-O check`, Verbindung war aber schon weg). Ohne Recovery
		// würde pi nur die verworrene „Permission denied“-Ausgabe sehen.
		if (res.exitCode !== 0 && DEAD_MASTER.test(res.output) && getControlSocket()) {
			if (await recoverMaster(remote)) return run(attempt + 1);
			throw new Error(deadMasterMessage(remote));
		}
		return res;
	};

	const execOnce = (): Promise<SshResult> =>
		new Promise((resolve, reject) => {
			// Abbrechbare Aufrufe laufen im Watchdog (siehe guard.ts): stdin bleibt
			// offen, Schließen räumt die Remote-Prozessgruppe ab.
			const guarded = Boolean(opts.signal || opts.timeout);
			const remoteCmd = guarded ? guardCommand(command, opts.stdin !== undefined) : command;
			const stdio: Array<"pipe" | "ignore"> =
				guarded || opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
			const child = spawn("ssh", [...sshCommandArgs(remote), remoteCmd], { stdio });
			const stdout = child.stdout!;
			const stderr = child.stderr!;
			const stdin = child.stdin!;
			const chunks: Buffer[] = [];
			let timedOut = false;
			let killTimer: NodeJS.Timeout | undefined;

			// Remote sauber beenden lassen (EOF → Watchdog); bleibt die Verbindung
			// stumm (Netz weg), nach der Gnadenfrist den lokalen Client killen.
			const stop = () => {
				if (killTimer) return;
				stdin.end();
				killTimer = setTimeout(() => child.kill(), (GUARD_GRACE_S + 3) * 1000);
			};

			const timer = opts.timeout
				? setTimeout(() => {
						timedOut = true;
						stop();
					}, opts.timeout * 1000)
				: undefined;

			stdout.on("data", (d: Buffer) => {
				chunks.push(d);
				opts.onData?.(d);
			});
			stderr.on("data", (d: Buffer) => {
				chunks.push(d);
				opts.onData?.(d);
			});

			const onAbort = () => stop();
			opts.signal?.addEventListener("abort", onAbort, { once: true });

			if (guarded || opts.stdin !== undefined) stdin.on("error", () => {});
			if (opts.stdin !== undefined) stdin.write(opts.stdin, () => guarded || stdin.end());
			if (opts.signal?.aborted) stop();

			child.on("error", (e) => {
				if (timer) clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				opts.signal?.removeEventListener("abort", onAbort);
				reject(e);
			});
			child.on("close", (code) => {
				if (timer) clearTimeout(timer);
				if (killTimer) clearTimeout(killTimer);
				opts.signal?.removeEventListener("abort", onAbort);
				const output = Buffer.concat(chunks).toString();
				if (opts.signal?.aborted) reject(new Error("aborted"));
				else if (timedOut) reject(new Error(`timeout:${opts.timeout}`));
				else resolve({ exitCode: code ?? -1, output });
			});
		});

	return run(0);
}

const WRONG_PW =
	/Sorry, try again|incorrect password|wrong password|authentication failure|passwd/i;

// ---------------------------------------------------------------------------
// Tool operation overrides
// ---------------------------------------------------------------------------

function createRemoteReadOps(remote: string, remoteCwd: string, localCwd: string): ReadOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		readFile: (p) =>
			spawnSsh(remote, `cat ${JSON.stringify(toRemote(p))}`).then((r) => Buffer.from(r.output)),
		access: (p) =>
			spawnSsh(remote, `test -r ${JSON.stringify(toRemote(p))}`).then((r) => {
				if (r.exitCode !== 0) throw new Error("not readable");
			}),
		detectImageMimeType: async (p) => {
			try {
				const r = await spawnSsh(remote, `file --mime-type -b ${JSON.stringify(toRemote(p))}`);
				const m = r.output.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

function createRemoteWriteOps(
	remote: string,
	remoteCwd: string,
	localCwd: string,
): WriteOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);
	return {
		writeFile: async (p, content) => {
			const r = await spawnSsh(
				remote,
				`echo ${JSON.stringify(Buffer.from(content).toString("base64"))} | base64 -d > ${JSON.stringify(toRemote(p))}`,
			);
			if (r.exitCode !== 0) throw new Error(`write failed: ${r.output}`);
		},
		mkdir: async (dir) => {
			const r = await spawnSsh(remote, `mkdir -p ${JSON.stringify(toRemote(dir))}`);
			if (r.exitCode !== 0) throw new Error(`mkdir failed: ${r.output}`);
		},
	};
}

function createRemoteEditOps(remote: string, remoteCwd: string, localCwd: string): EditOperations {
	const r = createRemoteReadOps(remote, remoteCwd, localCwd);
	const w = createRemoteWriteOps(remote, remoteCwd, localCwd);
	return { readFile: r.readFile, access: r.access, writeFile: w.writeFile };
}

function createRemoteBashOps(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	ctx: ExtensionContext,
): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);

	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const base = `cd ${JSON.stringify(toRemote(cwd))} && `;

			// ohne sudo: unverändert ausführen
			if (!usesSudo(command)) {
				const r = await spawnSsh(remote, base + command, { onData, signal, timeout });
				return { exitCode: r.exitCode };
			}
			// sudo kommt hier nur noch aus `!`-Kommandos; das bash-Tool lehnt es ab
			return execWithSudoPass(ctx, remote, command, base + injectSudoStdin(command), {
				onData,
				signal,
				timeout,
			});
		},
	};
}

/** Remote-Ausführung für das `sudo`-Tool: der ganze Befehl läuft als root. */
function createRemoteSudoOps(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	ctx: ExtensionContext,
): BashOperations {
	const toRemote = (p: string) => p.replace(localCwd, remoteCwd);

	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			execWithSudoPass(
				ctx,
				remote,
				command,
				`cd ${JSON.stringify(toRemote(cwd))} && sudo -S -p '' ${rootGuardArgs(command)}`,
				{ onData, signal, timeout },
			),
	};
}

/**
 * Führt `full` mit dem sudo-Passwort auf stdin aus (bei abgelaufener TTL wird
 * neu gefragt); bei falschem Passwort einmal frisch nachfragen.
 */
async function execWithSudoPass(
	ctx: ExtensionContext,
	remote: string,
	reason: string,
	full: string,
	opts: { onData?: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number }> {
	// bei abgelaufener TTL den alten Klartext-String aus dem Heap freigeben
	let pass: string | undefined;
	if (isSudoFresh()) {
		pass = getSudoPass()!;
	} else {
		forgetSudo();
		pass = await promptSudoPassword(ctx, remote, reason);
	}
	if (pass === undefined) {
		throw new Error(`[ssh.ts] sudo-Passwort-Eingabe abgebrochen für ${remote}`);
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await spawnSsh(remote, full, { ...opts, stdin: `${pass}\n` });
		if (r.exitCode === 0) return { exitCode: 0 };

		if (WRONG_PW.test(r.output)) {
			forgetSudo();
			if (attempt === 0) {
				pass = await promptSudoPassword(ctx, remote, reason);
				if (pass === undefined)
					throw new Error(`[ssh.ts] sudo-Passwort-Eingabe abgebrochen für ${remote}`);
				continue;
			}
		}
		return { exitCode: r.exitCode };
	}
	return { exitCode: 1 };
}

// ---------------------------------------------------------------------------
// Extension entrypoint
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	emitEvent = (name, data) => pi.events.emit(name, data);
	pi.registerFlag("ssh", {
		description: "SSH remote: user@host or user@host:/path",
		type: "string",
	});

	const localCwd = process.cwd();
	const localRead = createReadTool(localCwd);
	const localWrite = createWriteTool(localCwd);
	const localEdit = createEditTool(localCwd);
	const localBash = createBashTool(localCwd);
	const bashDef = createBashToolDefinition(localCwd);

	let resolvedSsh: { remote: string; remoteCwd: string } | null = null;
	const getSsh = () => resolvedSsh;

	pi.registerTool({
		...localRead,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createReadTool(localCwd, {
					operations: createRemoteReadOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localRead.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localWrite,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createWriteTool(localCwd, {
					operations: createRemoteWriteOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localWrite.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localEdit,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh) {
				const tool = createEditTool(localCwd, {
					operations: createRemoteEditOps(ssh.remote, ssh.remoteCwd, localCwd),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localEdit.execute(id, params, signal, onUpdate);
		},
	});

	pi.registerTool({
		...localBash,
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (ssh) {
				const input = params as BashToolInput;
				// sudo läuft ausschließlich über das sudo-Tool
				if (usesSudo(input.command ?? "")) {
					throw new Error(
						`sudo is not available in the bash tool on ${ssh.remote}. ` +
							'Use the sudo tool instead and pass the command without the leading "sudo".',
					);
				}
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd, ctx),
				});
				return tool.execute(id, params, signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	// Nur im --ssh-Modus aktiv (siehe session_start); Streaming, Truncation,
	// Timeout und Rendering kommen vom bash-Tool, nur die Ausführung ist eigen.
	pi.registerTool({
		...localBash,
		name: "sudo",
		label: "sudo",
		// Ohne eingebautes Gegenstück rendert pi sonst nur generisch (ohne Befehl):
		// bash-Renderer übernehmen, Aufrufzeile als `sudo $ …` kennzeichnen
		renderCall(args, theme, context) {
			const text = bashDef.renderCall!(args, theme, context) as Text;
			const timeout = args?.timeout ? theme.fg("muted", ` (timeout ${args.timeout}s)`) : "";
			text.setText(theme.fg("toolTitle", theme.bold(`sudo $ ${args?.command || "..."}`)) + timeout);
			return text;
		},
		renderResult: bashDef.renderResult,
		description:
			"Execute a bash command as root on the SSH remote host. Pass the command WITHOUT a leading " +
			'"sudo"; it runs via `sudo bash -c`, so pipes, && and redirects all run as root. The sudo ' +
			"password is requested from the user and supplied automatically; the call never hangs waiting " +
			"for a password. Output, truncation and the optional timeout (seconds) behave like the bash tool.",
		promptSnippet: "Execute a bash command as root on the SSH remote host",
		promptGuidelines: [
			"Use the sudo tool for every command that needs root on the SSH remote; the bash tool rejects sudo there.",
			'Pass commands to the sudo tool without a leading "sudo" and without -n/-S; a required password is not a reason to give up.',
		],
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (!ssh) throw new Error("[ssh.ts] sudo-Tool ist nur mit --ssh verfügbar");
			const input = params as BashToolInput;
			if (/^\s*sudo\b/.test(input.command ?? "")) {
				throw new Error(
					'Pass the command without the leading "sudo" – the sudo tool already runs it as root.',
				);
			}
			// Vorab-Prompt, damit das Passwort-Fenster NICHT in der Mitte
			// des Command-Streamings überraschend auftaucht, sondern explizit.
			if (!isSudoFresh()) {
				forgetSudo();
				const p = await promptSudoPassword(ctx, ssh.remote, input.command);
				if (p === undefined) {
					throw new Error(`[ssh.ts] sudo-Passwort-Eingabe abgebrochen für ${ssh.remote}`);
				}
			}
			const tool = createBashTool(localCwd, {
				operations: createRemoteSudoOps(ssh.remote, ssh.remoteCwd, localCwd, ctx),
			});
			return tool.execute(id, params, signal, onUpdate);
		},
	});

	const setSudoToolActive = (on: boolean) => {
		const others = pi.getActiveTools().filter((n) => n !== "sudo");
		pi.setActiveTools(on ? [...others, "sudo"] : others);
	};

	pi.on("session_start", async (_event, ctx) => {
		// sudo-Tool erst nach erfolgreicher SSH-Verbindung aktivieren, damit
		// normale Sessions weder Tool noch Prompt-Guidelines sehen
		setSudoToolActive(false);
		const arg = pi.getFlag("ssh") as string | undefined;
		if (!arg) return;

		let remote: string;
		let remoteCwd: string | null = null;
		if (arg.includes(":")) {
			const [r, p] = arg.split(":");
			remote = r;
			remoteCwd = p;
		} else {
			remote = arg;
		}

		// Interaktive Authentifizierung (ED25519-SK/YubiKey: PIN + Touch), falls
		// noch kein lebender ControlMaster existiert. Erst danach läuft die Session.
		const primed = await primeControlMaster(ctx, remote);
		if (!primed) {
			ctx.ui.notify(
				`SSH-Authentifizierung für ${remote} fehlgeschlagen – Session ohne Remote`,
				"error",
			);
			return;
		}
		// Ab jetzt kann ein unterwegs gestorbener Master automatisch neu
		// authentifiziert werden (siehe spawnSsh / recoverMaster).
		reprimeHook = (r) => primeControlMaster(ctx, r);

		if (remoteCwd === null) {
			remoteCwd = (await spawnSsh(remote, "pwd")).output.trim();
		}
		resolvedSsh = { remote, remoteCwd };
		setSudoToolActive(true);

		ctx.ui.setStatus(
			"ssh",
			ctx.ui.theme?.fg?.("accent", `SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`) ??
				`SSH: ${resolvedSsh.remote}:${resolvedSsh.remoteCwd}`,
		);
		ctx.ui.notify(`SSH ${resolvedSsh.remote}:${resolvedSsh.remoteCwd} – authentifiziert`, "info");
	});

	pi.on("user_bash", (event, ctx) => {
		const ssh = getSsh();
		if (!ssh) return;
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd, ctx) };
	});

	pi.on("session_shutdown", () => {
		// Hook nicht über Sessions hinweg weiterschleppen.
		reprimeHook = undefined;
	});

	pi.on("before_agent_start", async (event) => {
		const ssh = getSsh();
		if (ssh) {
			const modified = event.systemPrompt.replace(
				`Current working directory: ${localCwd}`,
				`Current working directory: ${ssh.remoteCwd} (via SSH: ${ssh.remote})`,
			);
			return { systemPrompt: modified };
		}
	});
}
