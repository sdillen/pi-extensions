import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	forgetSudo,
	getSudoPass,
	injectSudoStdin,
	isSudoFresh,
	rememberSudo,
	SUDO_TTL_MS,
	usesSudo,
} from "./sudo.ts";

describe("usesSudo", () => {
	it("detects sudo at the start of a command", () => {
		expect(usesSudo("sudo apt update")).toBe(true);
		expect(usesSudo("sudo")).toBe(true);
	});

	it("detects sudo behind wrappers (timeout/env/nice/…)", () => {
		expect(usesSudo("timeout 10 sudo ls")).toBe(true);
		expect(usesSudo("timeout 10s sudo ls")).toBe(true);
		expect(usesSudo("env X=1 sudo -n ls")).toBe(true);
		expect(usesSudo("nice -n 5 sudo ls")).toBe(true);
		expect(usesSudo("nohup sudo ls")).toBe(true);
		expect(usesSudo("time sudo ls")).toBe(true);
	});

	it("detects sudo after separators (& ; newline)", () => {
		expect(usesSudo("echo a; sudo ls")).toBe(true);
		expect(usesSudo("ls && sudo ls")).toBe(true);
		expect(usesSudo("echo a\nsudo ls")).toBe(true);
		expect(usesSudo("(sudo ls)")).toBe(true);
	});

	it("does not detect sudo when it is merely mentioned", () => {
		expect(usesSudo("ls -la")).toBe(false);
		expect(usesSudo("echo sudo is great")).toBe(false);
		expect(usesSudo("timed sudo")).toBe(false);
		expect(usesSudo("ls && echo sudo")).toBe(false);
		expect(usesSudo("systemd-run --no-block sudo true")).toBe(false);
	});
});

describe("injectSudoStdin", () => {
	it("converts the first sudo call into sudo -S -p ''", () => {
		expect(injectSudoStdin("sudo apt update")).toBe("sudo -S -p '' apt update");
	});

	it("removes -n / --non-interactive, keeps other options", () => {
		expect(injectSudoStdin("sudo -n apt")).toBe("sudo -S -p '' apt");
		expect(injectSudoStdin("sudo --non-interactive apt")).toBe("sudo -S -p '' apt");
		expect(injectSudoStdin("sudo -n -E apt")).toBe("sudo -S -p '' -E apt");
		expect(injectSudoStdin("sudo -n -n ls")).toBe("sudo -S -p '' ls");
	});

	it("preserves the wrapper prefix", () => {
		expect(injectSudoStdin("timeout 10 sudo ls")).toBe("timeout 10 sudo -S -p '' ls");
		expect(injectSudoStdin("env X=1 sudo -n ls")).toBe("env X=1 sudo -S -p '' ls");
	});

	it("leaves commands without sudo unchanged", () => {
		expect(injectSudoStdin("ls -la")).toBe("ls -la");
	});

	it("rewrites only the first sudo call", () => {
		expect(injectSudoStdin("sudo one; sudo two")).toBe("sudo -S -p '' one; sudo two");
	});
});

describe("sudo password state", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(1_000_000);
		forgetSudo();
	});
	afterEach(() => {
		vi.useRealTimers();
	});

	it("remembers the password trimmed", () => {
		rememberSudo("  secret  ");
		expect(getSudoPass()).toBe("secret");
		expect(isSudoFresh()).toBe(true);
	});

	it("becomes stale after SUDO_TTL_MS", () => {
		rememberSudo("secret");
		vi.advanceTimersByTime(SUDO_TTL_MS - 1);
		expect(isSudoFresh()).toBe(true);
		vi.advanceTimersByTime(1);
		expect(isSudoFresh()).toBe(false);
	});

	it("forgetSudo clears the password", () => {
		rememberSudo("secret");
		forgetSudo();
		expect(getSudoPass()).toBeNull();
		expect(isSudoFresh()).toBe(false);
	});
});
