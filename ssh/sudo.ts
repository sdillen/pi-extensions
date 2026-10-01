// ---------------------------------------------------------------------------
// sudo password state + command rewriting
//
// Das Passwort lebt NUR in diesem Modul (Extension-Speicher), nie im
// LLM-Context oder in der Session-Datei. Reine Logik ohne pi-Abhängigkeit –
// daher direkt testbar.
// ---------------------------------------------------------------------------

let sudoPass: string | null = null;
let sudoPassAt = 0;
export const SUDO_TTL_MS = 4 * 60 * 1000; // erneut fragen, wenn länger als 4 min her

export const isSudoFresh = () => sudoPass !== null && Date.now() - sudoPassAt < SUDO_TTL_MS;
export function rememberSudo(pass: string) {
	sudoPass = pass.trim();
	sudoPassAt = Date.now();
}
export function forgetSudo() {
	sudoPass = null;
}

/** Rohwert für den `sudo -S`-stdin-Kanal – nur aus der Extension nutzen, nie loggen. */
export function getSudoPass(): string | null {
	return sudoPass;
}

// sudo am Kommandoanfang, auch hinter Wrappern wie `timeout 10`, `env X=1`,
// `nice -n 5`; Gruppe 3 = direkt folgende sudo-Optionen
const SUDO_RE =
	/(^|[\n;&|(])(\s*(?:(?:timeout|nice|nohup|stdbuf|env|time)(?:\s+(?:-\S+|\d+(?:\.\d+)?[smhd]?|[A-Za-z_]\w*=\S*|[A-Z]+))*\s+)*)sudo\b((?:\s+-\S+)*)/;

/** True wenn `command` sudo wirklich ausführt (nicht nur erwähnt). */
export function usesSudo(command: string): boolean {
	return SUDO_RE.test(command);
}

/**
 * Ersten sudo-Aufruf in `sudo -S -p ''` umwandeln; Rest liest stdin bereits ab.
 * `-n`/`--non-interactive` fliegt raus – sonst ignoriert sudo das Passwort auf stdin.
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
