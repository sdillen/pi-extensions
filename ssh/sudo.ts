// ---------------------------------------------------------------------------
// sudo password state + command rewriting
//
// The password lives ONLY in this module (extension memory), never in the
// LLM context or in the session file. Pure logic without a pi dependency –
// hence directly testable.
// ---------------------------------------------------------------------------

let sudoPass: string | null = null;
let sudoPassAt = 0;
export const SUDO_TTL_MS = 4 * 60 * 1000; // ask again if more than 4 min ago

export const isSudoFresh = () => sudoPass !== null && Date.now() - sudoPassAt < SUDO_TTL_MS;
export function rememberSudo(pass: string) {
	sudoPass = pass.trim();
	sudoPassAt = Date.now();
}
export function forgetSudo() {
	sudoPass = null;
}
/** Sliding window: each use of the cached password restarts the TTL. */
export function touchSudo() {
	if (sudoPass !== null) sudoPassAt = Date.now();
}

/** Raw value for the `sudo -S` stdin channel – use only from the extension, never log. */
export function getSudoPass(): string | null {
	return sudoPass;
}

// sudo at the start of a command, also behind wrappers like `timeout 10`,
// `env X=1`, `nice -n 5`; group 3 = directly following sudo options
const SUDO_RE =
	/(^|[\n;&|(])(\s*(?:(?:timeout|nice|nohup|stdbuf|env|time)(?:\s+(?:-\S+|\d+(?:\.\d+)?[smhd]?|[A-Za-z_]\w*=\S*|[A-Z]+))*\s+)*)sudo\b((?:\s+-\S+)*)/;

/** True if `command` actually runs sudo (not merely mentions it). */
export function usesSudo(command: string): boolean {
	return SUDO_RE.test(command);
}

/**
 * Convert the first sudo call into `sudo -S -p ''`; the rest already reads stdin.
 * `-n`/`--non-interactive` is dropped – otherwise sudo ignores the password on stdin.
 */
export function injectSudoStdin(command: string): string {
	return command.replace(SUDO_RE, (_m, sep: string, prefix: string, opts: string) => {
		const kept = opts
			.split(/\s+/)
			.filter((o) => o && o !== "--non-interactive")
			.map((o) => (/^-[A-Za-z]+$/.test(o) ? o.replace(/n/g, "") : o))
			.filter((o) => o !== "-");
		return `${sep}${prefix}sudo -S -p ''${kept.map((o) => ` ${o}`).join("")}`;
	});
}
