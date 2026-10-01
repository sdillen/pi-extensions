/**
 * Brave Web Search — custom Pi-Tool über die Brave „LLM Context“-API.
 *
 * Der LLM-Context-Endpoint (POST https://api.search.brave.com/res/v1/llm/context)
 * ist genau für Agents gemacht: Er liefert nicht nur URLs, sondern bereits
 * vor-extrahierte, LLM-optimierte Content-Snippets (Text, Tabellen, Code,
 * Forums-/Captions-Inhalte) inkl. Quellen-Metadaten (Titel, Hostname, Datum).
 * Kein Scraping nötig – die LLM-Anbindung bekommt gebrauchsfertigen Context
 * in einem einzigen Call. (Statt klassischer Web Search mit Linklisten.)
 *
 * API-Key (bewusst NICHT im Repo/Nix, s. AGENTS.md). Priorität:
 *   1. macOS Keychain (primär): Service „pi-brave-search“ / Account „api-key".
 *      - Speichern bequem per `/brave-key set` (liest die Zwischenablage)
 *      - oder manuell: security add-generic-password -s "pi-brave-search" \
 *          -a "api-key" -w "<KEY>"
 *   2. Env-Var:   BRAVE_API_KEY=<key>
 *   3. Datei:     ~/.config/brave/api-key  (eine Zeile, nicht versioniert)
 *   Key besorgen: https://api-dashboard.search.brave.com
 *
 * Der Key wird bei jedem Tool-Call aus der Keychain gelesen („security
 * find-generic-password -w“). Das läuft über den Subprozess `/usr/bin/security`
 * — falls macOS einmal fragt, ob „security“ auf den Eintrag zugreifen darf,
 * einmal erlauben („Allow always / Immer erlauben“).
 *
 * Live testen ohne `make darwin` (aus diesem Repo):
 *   pi -e ./brave-search/brave-search.ts        → Brave Web Search Tool
 *   /brave-key set                               → Key aus Zwischenablage in Keychain
 *   /brave-test                                  → Key + Endpoint prüfen
 * Ein netter Umweg: Das Tool wird nach `make darwin` (Symlink in
 * ~/.pi/agent/extensions/) automatisch entdeckt und per /reload aktualisiert.
 */

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateHead,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { Text } from "@earendil-works/pi-tui";

const ENDPOINT = "https://api.search.brave.com/res/v1/llm/context";
const TIMEOUT_MS = 30_000; // Brave-Empfehlung: 30s Timeout
const MAX_ATTEMPTS = 3;

// ---------------------------------------------------------------------------
// API-Key: macOS Keychain (primär), sonst Env-Var, sonst Datei.
// Nie hardcoded, nie im Repo. Der Key verlässt nie den Rechner und wird
// nie in den LLM-Context oder die Session-Datei geschrieben.
// ---------------------------------------------------------------------------
const KEYCHAIN_SERVICE = "pi-brave-search";
const KEYCHAIN_ACCOUNT = "api-key";
const execFileAsync = promisify(execFile);

async function keychainGet(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync(
			"/usr/bin/security",
			["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w"],
			{ timeout: 5000 },
		);
		const v = stdout.trim();
		return v || undefined;
	} catch {
		return undefined; // Eintrag existiert nicht (security exit != 0)
	}
}

async function keychainSet(value: string): Promise<void> {
	// -U: bereits vorhandenen Eintrag aktualisieren statt doppelt anzulegen
	await execFileAsync(
		"/usr/bin/security",
		["add-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT, "-w", value, "-U"],
		{ timeout: 5000 },
	);
}

async function keychainDelete(): Promise<void> {
	try {
		await execFileAsync(
			"/usr/bin/security",
			["delete-generic-password", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT],
			{ timeout: 5000 },
		);
	} catch {
		/* Eintrag existierte nicht */
	}
}

/** Liest die macOS-Zwischenablage (für /brave-key set). */
async function pbpaste(): Promise<string | undefined> {
	try {
		const { stdout } = await execFileAsync("/usr/bin/pbpaste", [], { timeout: 3000 });
		const v = stdout.trim();
		return v || undefined;
	} catch {
		return undefined;
	}
}

/** Kurz-Maske für Status-Anzeigen (nie den vollen Key zeigen). */
function maskKey(key: string): string {
	if (key.length <= 10) return "*".repeat(key.length);
	return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

async function resolveApiKey(): Promise<string | undefined> {
	const fromKeychain = await keychainGet();
	if (fromKeychain) return fromKeychain;

	const fromEnv = process.env.BRAVE_API_KEY;
	if (fromEnv?.trim()) return fromEnv.trim();

	const candidates = [
		path.join(os.homedir(), ".config", "brave", "api-key"),
		path.join(os.homedir(), ".brave-search-api-key"),
	];
	for (const p of candidates) {
		try {
			const v = fs.readFileSync(p, "utf8").trim();
			if (v) return v;
		} catch {
			/* Datei existiert nicht -> nächster Kandidat */
		}
	}
	return undefined;
}

/**
 * Key für einen Tool-Call besorgen. Fehlt er, wird auf Wunsch einmal
 * interaktiv aus der Zwischenablage in die Keychain gelegt.
 */
// "success" ist kein offizielles notify-Level (Typen: info|warning|error),
// wird von der TUI-Runtime aber gerendert (seit 08/2026 im Einsatz).
// Bewusster Cast, Verhalten unverändert.
function notifySuccess(ctx: { ui: ExtensionContext["ui"] }, message: string): void {
	ctx.ui.notify(message, "success" as "info");
}

async function ensureApiKey(ctx?: ExtensionContext): Promise<string> {
	const existing = await resolveApiKey();
	if (existing) return existing;

	if (ctx?.ui && typeof ctx.ui.confirm === "function") {
		const ok = await ctx.ui.confirm(
			"Brave API-Key fehlt",
			"Kein Key in Keychain/Env gefunden. Key in die Zwischenablage kopiert? " +
				"Soll ich ihn jetzt in die macOS Keychain legen?".trim(),
		);
		if (ok) {
			const clip = await pbpaste();
			if (clip) {
				await keychainSet(clip);
				notifySuccess(ctx, "Brave-API-Key in der Keychain gespeichert");
				return clip;
			}
		}
	}

	throw new Error(
		"Kein Brave-API-Key gefunden. Setze ihn per /brave-key set (Zwischenablage), " +
			"export BRAVE_API_KEY oder ~/.config/brave/api-key.",
	);
}

// ---------------------------------------------------------------------------
// HTTP: 30s-Timeout, Pi-Signal-Cancellation, Retry mit Backoff (429/5xx)
// ---------------------------------------------------------------------------
class RetryableError extends Error {
	retryAfterMs: number;
	constructor(message: string, retryAfterMs = 1000) {
		super(message);
		this.retryAfterMs = retryAfterMs;
	}
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

interface BraveSource {
	title?: string;
	hostname?: string;
	age?: string[];
	description?: string;
}

interface BraveGeneric {
	url?: string;
	title?: string;
	snippets?: string[];
}

interface BraveResponse {
	grounding?: {
		generic?: BraveGeneric[];
		map?: unknown[];
		poi?: unknown;
	};
	sources?: Record<string, BraveSource>;
}

async function fetchBraveContext(
	body: Record<string, unknown>,
	apiKey: string,
	externalSignal?: AbortSignal,
): Promise<BraveResponse> {
	let lastError: Error | undefined;
	for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
		try {
			return await doFetch(body, apiKey, externalSignal);
		} catch (err) {
			lastError = err as Error;
			if (!(err instanceof RetryableError)) throw err; // harte Fehler sofort
			if (attempt + 1 >= MAX_ATTEMPTS) break;
			await sleep(err.retryAfterMs);
		}
	}
	throw lastError ?? new Error("Brave search failed");
}

async function doFetch(
	body: Record<string, unknown>,
	apiKey: string,
	externalSignal?: AbortSignal,
): Promise<BraveResponse> {
	const timeoutSignal = AbortSignal.timeout(TIMEOUT_MS);
	const signal =
		externalSignal && typeof AbortSignal.any === "function"
			? AbortSignal.any([timeoutSignal, externalSignal])
			: timeoutSignal;

	let res: Response;
	try {
		res = await fetch(ENDPOINT, {
			method: "POST",
			headers: {
				"X-Subscription-Token": apiKey,
				"Content-Type": "application/json",
				Accept: "application/json",
				"Accept-Encoding": "gzip",
			},
			body: JSON.stringify(body),
			signal,
		});
	} catch (err) {
		if (externalSignal?.aborted) throw new Error("Brave search aborted");
		if ((err as Error).name === "TimeoutError")
			throw new Error(`Brave search timed out after ${TIMEOUT_MS / 1000}s`);
		throw new RetryableError(`Brave network error: ${(err as Error).message}`);
	}

	if (!res.ok) {
		const text = await res.text().catch(() => "");
		if (res.status === 429) {
			const retryAfter = Number(res.headers.get("retry-after"));
			const backoff =
				Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : 1500;
			throw new RetryableError("Brave rate limited (429)", backoff);
		}
		if (res.status >= 500)
			throw new RetryableError(`Brave API ${res.status}: ${text.slice(0, 200)}`, 1500);
		throw new Error(`Brave API error ${res.status}: ${text.slice(0, 300) || res.statusText}`);
	}

	return (await res.json()) as BraveResponse;
}

// ---------------------------------------------------------------------------
// Antwort → kompaktes, zitierfähiges Markdown
// ---------------------------------------------------------------------------
function formatResults(query: string, data: BraveResponse): string {
	const generic = data.grounding?.generic ?? [];
	const sources = data.sources ?? {};

	if (generic.length === 0) {
		return (
			`Keine relevanten Inhalte für „${query}“ gefunden. ` +
			`Nicht verwechseln: leeres grounding.generic = kein Treffer. ` +
			`Versuche eine andere Formulierung, breitere Begriffe oder passe country/search_lang an.`
		);
	}

	const totalSnippets = generic.reduce((n, g) => n + (g.snippets?.length ?? 0), 0);
	const lines: string[] = [];
	lines.push(`# Web-Suche: ${query}`);
	lines.push(`Quellen: ${generic.length} · Snippets: ${totalSnippets}`);

	generic.forEach((g, i) => {
		const src = sources[g.url ?? ""];
		const date = src?.age?.[0] ? `  (${src.age[0]})` : "";
		const title = g.title ?? src?.title ?? g.url ?? `Quelle ${i + 1}`;
		lines.push(`\n${i + 1}. ${title}${date}`);
		if (g.url) lines.push(`   ${g.url}`);
		for (const s of g.snippets ?? []) lines.push(`   - ${s}`);
	});

	return lines.join("\n");
}

function writeTempFile(content: string): string {
	const file = path.join(
		os.tmpdir(),
		`brave-search-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.txt`,
	);
	fs.writeFileSync(file, content, "utf8");
	return file;
}

// ---------------------------------------------------------------------------
// Details für TUI-Rendering
// ---------------------------------------------------------------------------
interface BraveDetails {
	query: string;
	resultCount: number;
	totalSnippets: number;
	tokenBudget: number | undefined;
	truncated: boolean;
	sources: Array<{ title?: string; url?: string; date?: string }>;
	error?: string;
}

// ---------------------------------------------------------------------------
// Extension
// ---------------------------------------------------------------------------
export default function braveSearchExtension(pi: ExtensionAPI) {
	pi.registerTool({
		name: "brave_search",
		label: "Brave Web Search",
		description:
			"Web search via the Brave LLM-Context API: returns pre-extracted, LLM-optimized content (text, tables, code) from multiple sources including URL and date – directly for agent grounding. Use it when the answer needs current or external knowledge (fact checks, current events, technical questions, research).",
		promptSnippet: "Web search (Brave) with pre-extracted LLM-ready content",
		promptGuidelines: [
			"Use brave_search when the answer needs current or external information rather than the model's internal knowledge.",
			"Raise maximum_number_of_tokens (e.g. 16384) and count for deep research; keep defaults for quick factual lookups.",
			"Assume brave_search returns ready-to-cite content: quote and cite the title/URL of the sources it provides.",
		],
		parameters: Type.Object({
			q: Type.String({ description: "Search query (1–400 characters, max 50 words)" }),
			count: Type.Optional(
				Type.Integer({
					default: 20,
					minimum: 1,
					maximum: 50,
					description: "Number of search results to consider",
				}),
			),
			maximum_number_of_urls: Type.Optional(
				Type.Integer({
					default: 10,
					minimum: 1,
					maximum: 50,
					description: "Maximum number of URLs in the response",
				}),
			),
			maximum_number_of_tokens: Type.Optional(
				Type.Integer({
					default: 4096,
					minimum: 1024,
					maximum: 32768,
					description:
						"Approximate token budget for the entire context. Lower for quick facts, raise for deep research (e.g. 16384).",
				}),
			),
			maximum_number_of_snippets: Type.Optional(
				Type.Integer({
					default: 50,
					minimum: 1,
					maximum: 256,
					description: "Maximum number of snippets across all URLs",
				}),
			),
			maximum_number_of_snippets_per_url: Type.Optional(
				Type.Integer({
					default: 8,
					minimum: 1,
					maximum: 100,
					description: "Maximum number of snippets per individual URL",
				}),
			),
			context_threshold_mode: Type.Optional(
				StringEnum(["strict", "balanced", "lenient", "disabled"] as const, {
					description:
						"Relevance threshold: strict = fewer, but more relevant results; balanced = well-balanced; lenient = more results, possibly less relevant; disabled = no filtering",
				}),
			),
			freshness: Type.Optional(
				Type.String({
					description: "Freshness filter: pd | pw | pm | py or date range YYYY-MM-DD-TO-YYYY-MM-DD",
				}),
			),
			safesearch: Type.Optional(
				StringEnum(["off", "moderate", "strict"] as const, {
					description: "Filter for adult content",
				}),
			),
			country: Type.Optional(
				Type.String({ description: "Two-letter country code for results (e.g. de)" }),
			),
			search_lang: Type.Optional(
				Type.String({ description: "Language preference for results (e.g. de)" }),
			),
		}),

		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const apiKey = await ensureApiKey(ctx);

			const body: Record<string, unknown> = {
				q: params.q,
				enable_source_metadata: true, // stellt description/site_name bereit
			};

			// Nur gesetzte optionale Parameter mitschicken
			const optionalInts = [
				"count",
				"maximum_number_of_urls",
				"maximum_number_of_tokens",
				"maximum_number_of_snippets",
				"maximum_number_of_snippets_per_url",
			] as const;
			for (const k of optionalInts) {
				const v = params[k];
				if (v !== undefined) body[k] = v;
			}
			const optionalStrings = [
				"context_threshold_mode",
				"freshness",
				"safesearch",
				"country",
				"search_lang",
			] as const;
			for (const k of optionalStrings) {
				const v = params[k];
				if (v !== undefined && v !== "") body[k] = v;
			}

			const data = await fetchBraveContext(body, apiKey, signal);
			const generic = data.grounding?.generic ?? [];

			const sources: BraveDetails["sources"] = generic.map((g) => ({
				title: g.title ?? data.sources?.[g.url ?? ""]?.title,
				url: g.url,
				date: data.sources?.[g.url ?? ""]?.age?.[0],
			}));

			const details: BraveDetails = {
				query: params.q,
				resultCount: generic.length,
				totalSnippets: generic.reduce((n, g) => n + (g.snippets?.length ?? 0), 0),
				tokenBudget:
					typeof params.maximum_number_of_tokens === "number"
						? params.maximum_number_of_tokens
						: undefined,
				truncated: false,
				sources,
			};

			let text = formatResults(params.q, data);

			// Sicherheitsnetz: Snippets sind zwar token-budgetiert, aber schützen
			// vor riesigen Antworten (Limit: 50KB / 2000 Zeilen).
			const truncation = truncateHead(text, {
				maxLines: DEFAULT_MAX_LINES,
				maxBytes: DEFAULT_MAX_BYTES,
			});
			if (truncation.truncated) {
				details.truncated = true;
				const tmp = writeTempFile(text);
				const tail = `\n\n[Output gekürzt: ${truncation.outputLines}/${truncation.totalLines} Zeilen ` +
					`(${formatSize(truncation.outputBytes)}/${formatSize(truncation.totalBytes)}). ` +
					`Komplett gespeichert: ${tmp}]`;
				text = truncation.content + tail;
			}

			return { content: [{ type: "text", text }], details };
		},

		// Kompaktes TUI-Rendering (erweitert für Quellenliste)
		renderCall(args, theme) {
			const textArgs = args as { q?: string };
			let t = theme.fg("toolTitle", theme.bold("Brave Web Search"));
			t += theme.fg("text", " ") + theme.fg("accent", textArgs?.q ?? "");
			return new Text(t, 0, 0);
		},

		renderResult(result, { expanded, isPartial }, theme, context) {
			if (isPartial) return new Text(theme.fg("muted", "Brave-Suche läuft…"), 0, 0);

			if (context.isError) {
				const msg =
					result.content?.[0]?.type === "text"
						? result.content[0].text.split("\n")[0]
						: "Fehler bei der Brave-Suche";
				return new Text(theme.fg("error", msg), 0, 0);
			}

			const details = result.details as BraveDetails | undefined;
			if (!details) return new Text(theme.fg("dim", "Brave-Suche"), 0, 0);

			let t = theme.fg("success", `✓ ${details.resultCount} Quellen`);
			if (details.totalSnippets > 0) t += theme.fg("muted", ` · ${details.totalSnippets} Snippets`);
			if (details.tokenBudget != null) t += theme.fg("muted", ` · ${details.tokenBudget} Tokens`);
			if (details.truncated) t += theme.fg("warning", " · gekürzt");

			if (expanded && details.sources.length) {
				for (const s of details.sources.slice(0, 20)) {
					t += `\n  ${theme.fg("dim", "•")} ${s.title ?? s.url ?? ""}`;
					if (s.url) t += theme.fg("dim", `  ${s.url}`);
				}
			}
			return new Text(t, 0, 0);
		},
	});

	// Schneller Key-/Connectivity-Check ohne echte Suche
	pi.registerCommand("brave-test", {
		description: "Brave-Suche: API-Key und Endpoint testen",
		handler: async (_args, ctx) => {
			const apiKey = await resolveApiKey();
			if (!apiKey) {
				ctx.ui.notify(
					"Brave-API-Key fehlt — /brave-key set (Zwischenablage) oder BRAVE_API_KEY (Env) nutzen",
					"warning",
				);
				return;
			}
			ctx.ui.notify("Teste Brave-API…", "info");
			const t0 = Date.now();
			try {
				const data = await fetchBraveContext(
					{ q: "hello world", count: 3, maximum_number_of_urls: 3, maximum_number_of_tokens: 2048 },
					apiKey,
				);
				const ms = Date.now() - t0;
				const hits = data.grounding?.generic?.length ?? 0;
				notifySuccess(ctx, `OK: ${hits} Quellen in ${ms}ms (Key gültig)`);
			} catch (err) {
				ctx.ui.notify(`Fehler: ${(err as Error).message}`, "error");
			}
		},
	});

	// API-Key-Verwaltung: macOS Keychain (Service „pi-brave-search“)
	pi.registerCommand("brave-key", {
		description: "Brave-API-Key in der macOS Keychain verwalten: /brave-key [status|set [KEY]|delete]",
		getArgumentCompletions: (prefix) => {
			const verbs = ["status", "set", "delete"];
			const p = prefix.toLowerCase();
			const hits = verbs.filter((v) => v.startsWith(p));
			return hits.length ? hits.map((v) => ({ value: v, label: v })) : null;
		},
		handler: async (args, ctx) => {
			const [verb = "", ...rest] = args.trim().split(/\s+/);
			const payload = rest.join(" ").trim();

			if (verb === "set") {
				let key = payload;
				let source = "Argument";
				if (!key) {
					const clip = await pbpaste();
					if (clip) {
						key = clip;
						source = "Zwischenablage";
					}
				}
				if (!key) {
					ctx.ui.notify(
						"Kein Key gefunden. Nutzung: /brave-key set <KEY> — oder den Key vorher in die Zwischenablage kopieren",
					"warning",
				);
				return;
			}
			try {
				await keychainSet(key.trim());
				notifySuccess(ctx, `Brave-API-Key gespeichert (${source}) → Keychain „${KEYCHAIN_SERVICE}“`);
			} catch (err) {
				ctx.ui.notify(`Konnte Keychain nicht schreiben: ${(err as Error).message}`, "error");
			}
			return;
		}

		if (verb === "delete") {
			const ok = await ctx.ui.confirm(
				"Brave-API-Key löschen?",
				`Der Eintrag „${KEYCHAIN_SERVICE}/${KEYCHAIN_ACCOUNT}“ wird aus der Keychain entfernt.`,
			);
			if (!ok) {
				ctx.ui.notify("Abgebrochen", "info");
				return;
			}
			await keychainDelete();
			notifySuccess(ctx, "Brave-API-Key aus der Keychain entfernt");
			return;
		}

		// default: status
		const key = await resolveApiKey();
		if (!key) {
			ctx.ui.notify(
				"Kein Brave-API-Key gefunden. /brave-key set (Key vorher in die Zwischenablage kopieren)",
				"warning",
			);
			return;
		}
		const keychainStored = (await keychainGet()) === key;
		const source = keychainStored
			? `Keychain „${KEYCHAIN_SERVICE}“`
			: key === (process.env.BRAVE_API_KEY ?? "").trim()
				? "Env-Var BRAVE_API_KEY"
				: "Datei ~/.config/brave/api-key";
		notifySuccess(ctx, `Brave-API-Key: ${maskKey(key)} (Quelle: ${source})`);
	},
	});
}
