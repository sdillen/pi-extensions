/**
 * SSH Remote Execution + sudo password prompt
 *
 * Extends the official examples/extensions/ssh.ts:
 *  - all built-in tools (read/write/edit/bash) run on the remote
 *  - `!` commands also run remotely
 *  - own `sudo` tool (only active with --ssh): runs the command as root via
 *    `sudo bash -c`; the bash tool rejects sudo on the remote and points to
 *    the sudo tool. `!` commands with sudo are still rewritten.
 *  - shows a masked dialog for sudo (ctx.ui.custom) in which you enter the
 *    sudo password – characters are rendered as *
 *  - the password is held only in extension memory (never in the LLM context
 *    or in the session file) and fed to the remote via `sudo -S` over stdin;
 *    after SUDO_TTL_MS it is asked for again
 *  - on a wrong password it asks once more
 *  - one-time interactive SSH authentication at session start for
 *    ED25519-SK / YubiKey (enter PIN + touch): the TUI is suspended, the
 *    terminal is handed to `ssh -N -f -M`, and the session only runs after
 *    successful authentication. After that, ALL remote calls ride on a
 *    ControlMaster socket (`~/.ssh/controlmaster/…`) and do not ask again.
 *    Control: `SSH_CONTROL_PERSIST` (seconds, default 43200).
 *
 * Usage (from this repo):
 *   pi -e ./ssh --ssh user@host
 *   pi -e ./ssh --ssh user@host:/remote/path
 * Or the deployed copy in ~/.pi/agent/extensions/ssh/ (auto-discovered).
 *
 * Requirements:
 *   - bash on remote
 *   - SSH key reachable. ED25519-SK/YubiKey is confirmed interactively once
 *     at startup (PIN + touch) instead of per tool call.
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
import { GUARD_GRACE_S, guardCommand, rootGuardArgs, shq } from "./guard.ts";
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
	touchSudo,
	usesSudo,
} from "./sudo.ts";

// ---------------------------------------------------------------------------

/**
 * Masked password input window for ctx.ui.custom().
 * - renders only `*` per character, the cursor stays visible as reverse video
 * - the raw value leaves the component exclusively via `done(value)`
 * - full editing: Backspace, Del, cursor, ctrl+u, ctrl+w, Paste
 */
export class MaskedPasswordPrompt implements Component, Focusable {
	focused = false;
	private raw = "";
	private cursor = 0; // index into [...raw]
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
			return; // intentionally ignored
		}
		// insert printable characters (reject control characters)
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
		// no cached rendering – nothing to do
	}

	render(width: number): string[] {
		const frameW = Math.max(20, Math.min(60, width - 4));
		const inner = frameW - 2; // inner width without side borders
		const tr = (s: string, max: number) => {
			const dots = s.length > max ? "…" : "";
			return s.slice(0, Math.max(0, max - dots.length)) + dots;
		};

		// masked line with horizontal scrolling + fake cursor (like pi input)
		const prompt = "> ";
		const avail = Math.max(1, inner - 2);
		// room for the masked text: avail minus prompt and the cursor cell
		const room = Math.max(0, avail - prompt.length - 1);
		const mask = "*".repeat(this.raw.length);
		let visible = mask;
		let cursorCol = this.cursor;
		if (mask.length > room) {
			const start = mask.length - room;
			visible = mask.slice(start);
			cursorCol = Math.max(0, this.cursor - start);
		}
		const visibleChars = [...visible];
		const atCursor = visibleChars[cursorCol] ?? " ";
		const before = visible.slice(0, cursorCol);
		const after = visible.slice(cursorCol + atCursor.length);
		const marker = this.focused ? CURSOR_MARKER : "";
		const content = before + marker + `\x1b[7m${atCursor}\x1b[27m` + after;
		// visible width without escape sequences (CURSOR_MARKER, SGR)
		const used = prompt.length + visibleChars.length + (cursorCol >= visibleChars.length ? 1 : 0);
		const bodyLine = prompt + content + " ".repeat(Math.max(0, avail - used));

		const hint = "Enter = accept · Esc = cancel";
		const top = `┌${"─".repeat(inner)}┐`;
		const bottom = `└${"─".repeat(inner)}┘`;
		const blank = `│${" ".repeat(inner)}│`;
		const titleLine = `│ ${tr(this.title, inner - 2).padEnd(inner - 2)} │`;
		const hintLine = `│ ${tr(hint, inner - 2).padEnd(inner - 2)} │`;
		const body = `│ ${bodyLine} │`;
		return [top, titleLine, blank, body, blank, hintLine, bottom];
	}
}

/**
 * Asks the user for the sudo password in a masked dialog.
 * Returns undefined if cancelled.
 */
async function promptSudoPassword(
	ctx: ExtensionContext,
	remote: string,
	reason: string,
): Promise<string | undefined> {
	if (!ctx.hasUI) {
		ctx.ui.notify("no interactive UI – cannot ask for the sudo password", "error");
		return undefined;
	}
	const title = `sudo password for ${remote}`;

	const pass = await (async () => {
		if (ctx.mode === "tui") {
			// masked dialog via ctx.ui.custom (editor is briefly replaced)
			try {
				return await ctx.ui.custom<string | undefined>(
					(_tui, _theme, _kb, done) => new MaskedPasswordPrompt(title, done),
				);
			} catch {
				return undefined;
			}
		}
		// Fallback without TUI: unmasked input dialog
		return ctx.ui.input(title, reason.startsWith("sudo") ? reason : undefined);
	})();
	const trimmed = pass?.trim();
	if (!trimmed) return undefined;
	rememberSudo(trimmed);
	ctx.ui.setStatus(
		"sudo",
		ctx.ui.theme?.fg?.("accent", "sudo: password accepted") ?? "sudo: accepted",
	);
	return trimmed;
}

const AUTH_TIMEOUT_MS = 120_000; // PIN + touch must succeed within 2 min

/** Default timeout (seconds) for remote bash/sudo calls without an explicit one. */
const REMOTE_DEFAULT_TIMEOUT_S = 300;

const withRemoteTimeout = <T extends { timeout?: number }>(params: T): T => ({
	...params,
	timeout: params.timeout ?? REMOTE_DEFAULT_TIMEOUT_S,
});

/**
 * Establishes a ControlMaster interactively (PIN + touch for ED25519-SK).
 * Suspends the TUI, hands the terminal to `ssh -N -f -o ControlMaster=auto`
 * and waits until authentication is done (`ssh -f` only returns 0 afterwards).
 * Returns true on success; the daemonized master stays in the background via
 * ControlPersist. With `auto`: when Pi sessions start in parallel, exactly ONE
 * master is established interactively; further sessions silently attach to the
 * socket during prime.
 */
async function primeControlMaster(ctx: ExtensionContext, remote: string): Promise<boolean> {
	const socket = socketPathFor(remote);
	fs.mkdirSync(path.dirname(socket), { recursive: true });

	// Is there already a live master (e.g. from an earlier session/ControlPersist)?
	// `ssh -O check` alone is NOT enough: zombies (process alive, transport dead)
	// report as "running". Only the real roundtrip through the socket proves it.
	if (isSocketAlive(socket, remote)) {
		if (canRoundTrip(socket, remote)) {
			setControlSocket(socket);
			return true;
		}
		// Zombie master: clean up and authenticate interactively from scratch below.
		ctx.ui.notify(`SSH: old master for ${remote} was dead (zombie) – new authentication`, "info");
	}
	// Remove the stale socket file of a dead master, otherwise ssh refuses.
	cleanupMaster(socket, remote);

	if (!ctx.hasUI || ctx.mode !== "tui") {
		ctx.ui.notify(
			`SSH auth for ${remote} needs an interactive terminal (YubiKey PIN+touch); mode "${ctx.mode}" is not suitable`,
			"error",
		);
		return false;
	}

	const ok = await ctx.ui
		.custom<boolean>((tui, _theme, _kb, done) => {
			// Suspend the TUI → hand the terminal (canonical mode) to ssh
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			process.stdout.write(
				`\x1b[1m>> SSH authentication for ${remote}\x1b[0m\n` +
					`Complete the SSH authentication prompt. The Pi session only starts afterwards.\n` +
					`(Ctrl-C = cancel)\n\n`,
			);

			const child: ChildProcess = spawn(
				"ssh",
				[
					"-N", // no remote command → stays available as master
					"-f", // go to background after successful auth (return afterwards)
					"-o",
					"ControlMaster=auto", // winner becomes master; if further Pi sessions start in parallel,
					// the loser silently attaches to the socket (no re-auth/stray).
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

			process.once("SIGINT", onSigint); // ONLY here: Ctrl-C cancels, does not kill pi
			child.on("error", () => finish(false));
			child.on("close", (code) => {
				// ssh -f only returns 0 AFTER successful auth. Socket creation
				// may lag slightly → poll briefly.
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
		})
		.catch(() => false);

	if (ok) {
		setControlSocket(socket);
	} else {
		ctx.ui.notify(`SSH authentication for ${remote} failed/cancelled`, "error");
	}
	return ok;
}

// ---------------------------------------------------------------------------
// SSH execution helpers
// ---------------------------------------------------------------------------

interface SshResult {
	exitCode: number;
	/** stdout and stderr interleaved, for messages and text */
	output: string;
	/** stdout only, byte-exact (file contents) */
	raw: Buffer;
}

/**
 * Set after session_start so that a ControlMaster that died midway can be
 * re-authenticated interactively and automatically (same PIN+touch dialog
 * as at startup).
 */
let reprimeHook: ((remote: string) => Promise<boolean>) | undefined;

function deadMasterMessage(remote: string): string {
	return (
		`[ssh.ts] SSH ControlMaster for ${remote} is dead (connection aborted) – ` +
		"automatic re-authentication failed. Please check the YubiKey and " +
		`pi --ssh ${remote}` +
		" restart (or repeat the last ssh command)."
	);
}

/** Resets the socket and tries once to re-authenticate interactively. */
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
		timeout?: number; // seconds
	} = {},
): Promise<SshResult> {
	const run = async (attempt: number): Promise<SshResult> => {
		// Repeated retry after recovery → abort clearly instead of retrying endlessly.
		if (attempt >= 2) {
			throw new Error(deadMasterMessage(remote));
		}

		// -O check (cached for 2 s) reports the socket unreachable → zombie/stale.
		// Before every real call, make sure the master is really up.
		if (getControlSocket() && !isMasterAlive(remote)) {
			if (await recoverMaster(remote)) return run(attempt + 1);
			throw new Error(deadMasterMessage(remote));
		}

		const res = await execOnce();

		// The running call stumbled over a dead master (e.g. the process was still
		// alive for `-O check`, but the connection was already gone). Without
		// recovery, pi would only see the confusing "Permission denied" output.
		if (res.exitCode !== 0 && DEAD_MASTER.test(res.output) && getControlSocket()) {
			if (await recoverMaster(remote)) return run(attempt + 1);
			throw new Error(deadMasterMessage(remote));
		}
		return res;
	};

	const execOnce = (): Promise<SshResult> =>
		new Promise((resolve, reject) => {
			// Abortable calls run in the watchdog (see guard.ts): stdin stays
			// open, closing it cleans up the remote process group.
			const guarded = Boolean(opts.signal || opts.timeout);
			const remoteCmd = guarded ? guardCommand(command, opts.stdin !== undefined) : command;
			const stdio: Array<"pipe" | "ignore"> =
				guarded || opts.stdin !== undefined ? ["pipe", "pipe", "pipe"] : ["ignore", "pipe", "pipe"];
			const child = spawn("ssh", [...sshCommandArgs(remote), remoteCmd], { stdio });
			const stdout = child.stdout!;
			const stderr = child.stderr!;
			const stdin = child.stdin!;
			const chunks: Buffer[] = [];
			const stdoutChunks: Buffer[] = [];
			let timedOut = false;
			let killTimer: NodeJS.Timeout | undefined;

			// Let the remote exit cleanly (EOF → watchdog); if the connection stays
			// silent (network gone), kill the local client after the grace period.
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
				stdoutChunks.push(d);
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
				else resolve({ exitCode: code ?? -1, output, raw: Buffer.concat(stdoutChunks) });
			});
		});

	return run(0);
}

const WRONG_PW =
	/Sorry, try again|incorrect password|wrong password|authentication failure|passwd/i;

// ---------------------------------------------------------------------------
// Tool operation overrides
// ---------------------------------------------------------------------------

export function createRemoteReadOps(
	remote: string,
	remoteCwd: string,
	localCwd: string,
): ReadOperations {
	// Map only the local cwd prefix; String.replace would hit the first match anywhere
	// and interpret `$&`-patterns in remoteCwd.
	const toRemote = (p: string) =>
		p.startsWith(localCwd) ? remoteCwd + p.slice(localCwd.length) : p;
	return {
		readFile: (p) =>
			spawnSsh(remote, `cat ${shq(toRemote(p))}`).then((r) => {
				if (r.exitCode !== 0) throw new Error(`read failed: ${r.output}`);
				return r.raw;
			}),
		access: (p) =>
			spawnSsh(remote, `test -r ${shq(toRemote(p))}`).then((r) => {
				if (r.exitCode !== 0) throw new Error("not readable");
			}),
		detectImageMimeType: async (p) => {
			try {
				const r = await spawnSsh(remote, `file --mime-type -b ${shq(toRemote(p))}`);
				const m = r.output.trim();
				return ["image/jpeg", "image/png", "image/gif", "image/webp"].includes(m) ? m : null;
			} catch {
				return null;
			}
		},
	};
}

export function createRemoteWriteOps(
	remote: string,
	remoteCwd: string,
	localCwd: string,
): WriteOperations {
	// Map only the local cwd prefix; String.replace would hit the first match anywhere
	// and interpret `$&`-patterns in remoteCwd.
	const toRemote = (p: string) =>
		p.startsWith(localCwd) ? remoteCwd + p.slice(localCwd.length) : p;
	return {
		writeFile: async (p, content) => {
			// content goes via stdin: as a command argument it would hit the
			// per-argument limit (~128 KiB) for larger files
			const r = await spawnSsh(remote, `base64 -d > ${shq(toRemote(p))}`, {
				stdin: Buffer.from(content).toString("base64"),
			});
			if (r.exitCode !== 0) throw new Error(`write failed: ${r.output}`);
		},
		mkdir: async (dir) => {
			const r = await spawnSsh(remote, `mkdir -p ${shq(toRemote(dir))}`);
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
	// Map only the local cwd prefix; String.replace would hit the first match anywhere
	// and interpret `$&`-patterns in remoteCwd.
	const toRemote = (p: string) =>
		p.startsWith(localCwd) ? remoteCwd + p.slice(localCwd.length) : p;

	return {
		exec: async (command, cwd, { onData, signal, timeout }) => {
			const base = `cd ${shq(toRemote(cwd))} && `;

			// without sudo: run unchanged
			if (!usesSudo(command)) {
				const r = await spawnSsh(remote, base + command, { onData, signal, timeout });
				return { exitCode: r.exitCode };
			}
			// sudo only arrives here from `!` commands; the bash tool rejects it
			return execWithSudoPass(ctx, remote, command, base + injectSudoStdin(command), {
				onData,
				signal,
				timeout,
			});
		},
	};
}

/** Remote execution for the `sudo` tool: the whole command runs as root. */
function createRemoteSudoOps(
	remote: string,
	remoteCwd: string,
	localCwd: string,
	ctx: ExtensionContext,
): BashOperations {
	// Map only the local cwd prefix; String.replace would hit the first match anywhere
	// and interpret `$&`-patterns in remoteCwd.
	const toRemote = (p: string) =>
		p.startsWith(localCwd) ? remoteCwd + p.slice(localCwd.length) : p;

	return {
		exec: (command, cwd, { onData, signal, timeout }) =>
			execWithSudoPass(
				ctx,
				remote,
				command,
				`cd ${shq(toRemote(cwd))} && sudo -S -p '' ${rootGuardArgs(command)}`,
				{ onData, signal, timeout },
			),
	};
}

/**
 * Runs `full` with the sudo password on stdin (asks again if the TTL has
 * expired); on a wrong password, ask once more from scratch.
 */
async function execWithSudoPass(
	ctx: ExtensionContext,
	remote: string,
	reason: string,
	full: string,
	opts: { onData?: (chunk: Buffer) => void; signal?: AbortSignal; timeout?: number },
): Promise<{ exitCode: number }> {
	// on expired TTL, release the old plaintext string from the heap
	let pass: string | undefined;
	if (isSudoFresh()) {
		pass = getSudoPass()!;
		touchSudo();
	} else {
		forgetSudo();
		pass = await promptSudoPassword(ctx, remote, reason);
	}
	if (pass === undefined) {
		throw new Error(`[ssh.ts] sudo password entry cancelled for ${remote}`);
	}

	for (let attempt = 0; attempt < 2; attempt++) {
		const r = await spawnSsh(remote, full, { ...opts, stdin: `${pass}\n` });
		if (r.exitCode === 0) return { exitCode: 0 };

		if (WRONG_PW.test(r.output)) {
			forgetSudo();
			if (attempt === 0) {
				pass = await promptSudoPassword(ctx, remote, reason);
				if (pass === undefined)
					throw new Error(`[ssh.ts] sudo password entry cancelled for ${remote}`);
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
				// sudo runs exclusively through the sudo tool
				if (usesSudo(input.command ?? "")) {
					throw new Error(
						`sudo is not available in the bash tool on ${ssh.remote}. ` +
							'Use the sudo tool instead and pass the command without the leading "sudo".',
					);
				}
				const tool = createBashTool(localCwd, {
					operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd, ctx),
				});
				return tool.execute(id, withRemoteTimeout(params), signal, onUpdate);
			}
			return localBash.execute(id, params, signal, onUpdate);
		},
	});

	// Only active in --ssh mode (see session_start); streaming, truncation,
	// timeout and rendering come from the bash tool, only the execution is custom.
	pi.registerTool({
		...localBash,
		name: "sudo",
		label: "sudo",
		// Parallel sudo calls would each see an empty password cache and open
		// their own password dialog; sequential mode queues them behind one prompt.
		executionMode: "sequential",
		// Without a built-in counterpart, pi would otherwise render only generically (without the command):
		// reuse the bash renderer, label the call line as `sudo $ …`
		renderCall(args, theme, context) {
			const text = bashDef.renderCall!(args, theme, context) as Text;
			const timeout = theme.fg("muted", ` (timeout ${args?.timeout ?? REMOTE_DEFAULT_TIMEOUT_S}s)`);
			text.setText(theme.fg("toolTitle", theme.bold(`sudo $ ${args?.command || "..."}`)) + timeout);
			return text;
		},
		renderResult: bashDef.renderResult,
		description:
			"Execute a bash command as root on the SSH remote host. Pass the command WITHOUT a leading " +
			'"sudo"; it runs via `sudo bash -c`, so pipes, && and redirects all run as root. The sudo ' +
			"password is requested from the user and supplied automatically; the call never hangs waiting " +
			`for a password. Output and truncation behave like the bash tool; timeout (seconds) defaults to ${REMOTE_DEFAULT_TIMEOUT_S}.`,
		promptSnippet: "Execute a bash command as root on the SSH remote host",
		promptGuidelines: [
			"Use the sudo tool for every command that needs root on the SSH remote; the bash tool rejects sudo there.",
			'Pass commands to the sudo tool without a leading "sudo" and without -n/-S; a required password is not a reason to give up.',
		],
		async execute(id, params, signal, onUpdate, ctx) {
			const ssh = getSsh();
			if (!ssh) throw new Error("[ssh.ts] sudo tool is only available with --ssh");
			const input = params as BashToolInput;
			if (/^\s*sudo\b/.test(input.command ?? "")) {
				throw new Error(
					'Pass the command without the leading "sudo" – the sudo tool already runs it as root.',
				);
			}
			// Upfront prompt, so that the password window does NOT pop up unexpectedly
			// in the middle of command streaming, but explicitly.
			if (!isSudoFresh()) {
				forgetSudo();
				const p = await promptSudoPassword(ctx, ssh.remote, input.command);
				if (p === undefined) {
					throw new Error(`[ssh.ts] sudo password entry cancelled for ${ssh.remote}`);
				}
			}
			const tool = createBashTool(localCwd, {
				operations: createRemoteSudoOps(ssh.remote, ssh.remoteCwd, localCwd, ctx),
			});
			return tool.execute(id, withRemoteTimeout(params), signal, onUpdate);
		},
	});

	const setSudoToolActive = (on: boolean) => {
		const others = pi.getActiveTools().filter((n) => n !== "sudo");
		pi.setActiveTools(on ? [...others, "sudo"] : others);
	};

	pi.on("session_start", async (_event, ctx) => {
		// Activate the sudo tool only after a successful SSH connection, so that
		// normal sessions see neither the tool nor the prompt guidelines
		setSudoToolActive(false);
		const arg = pi.getFlag("ssh") as string | undefined;
		if (!arg) return;

		let remote: string;
		let remoteCwd: string | null = null;
		if (arg.includes(":")) {
			// only the first colon separates host and path; the path may contain colons
			const sep = arg.indexOf(":");
			remote = arg.slice(0, sep);
			remoteCwd = arg.slice(sep + 1);
		} else {
			remote = arg;
		}

		// Interactive authentication (ED25519-SK/YubiKey: PIN + touch), if
		// no live ControlMaster exists yet. Only then does the session run.
		const primed = await primeControlMaster(ctx, remote);
		if (!primed) {
			ctx.ui.notify(`SSH authentication for ${remote} failed – session without remote`, "error");
			return;
		}
		// From now on, a master that died midway can be re-authenticated
		// automatically (see spawnSsh / recoverMaster).
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
		ctx.ui.notify(`SSH ${resolvedSsh.remote}:${resolvedSsh.remoteCwd} – authenticated`, "info");
	});

	pi.on("user_bash", (event, ctx) => {
		const ssh = getSsh();
		if (!ssh) return;
		return { operations: createRemoteBashOps(ssh.remote, ssh.remoteCwd, localCwd, ctx) };
	});

	pi.on("session_shutdown", () => {
		// Do not carry the hook over across sessions.
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
