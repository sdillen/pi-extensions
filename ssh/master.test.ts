import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAD_MASTER, SSH_CONTROL_PERSIST } from "./master.ts";

const { spawnSyncMock, rmSyncMock } = vi.hoisted(() => ({
	spawnSyncMock: vi.fn(),
	rmSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("node:fs", () => ({ rmSync: rmSyncMock }));

// Nach den vi.mock-Aufrufen importieren, damit master.ts die Mocks bekommt.
const {
	canRoundTrip,
	cleanupMaster,
	invalidateMaster,
	isMasterAlive,
	isSocketAlive,
	setControlSocket,
	socketPathFor,
	sshCommandArgs,
} = await import("./master.ts");

const remote = "user@example.org";
const sock = "/tmp/controlmaster/user@example.org.sock";
const ok = { status: 0 };

beforeEach(() => {
	vi.useFakeTimers();
	vi.setSystemTime(1_000_000);
	spawnSyncMock.mockReset();
	spawnSyncMock.mockReturnValue(ok);
	rmSyncMock.mockReset();
	invalidateMaster();
});

afterEach(() => {
	vi.useRealTimers();
});

describe("socketPathFor", () => {
	it("legt den Socket unter ~/.ssh/controlmaster ab", () => {
		expect(socketPathFor(remote)).toBe(
			`${process.env.HOME}/.ssh/controlmaster/user@example.org.sock`,
		);
	});

	it("ersetzt gefährliche Zeichen, behält host:port", () => {
		const p = socketPathFor("usér@höst:1");
		expect(p.endsWith("/controlmaster/us_r@h_st:1.sock")).toBe(true);
	});
});

describe("sshCommandArgs", () => {
	it("liefert ohne Socket nur den Remote", () => {
		expect(sshCommandArgs(remote)).toEqual([remote]);
	});

	it("reitet über den ControlMaster-Socket, sobald gesetzt", () => {
		setControlSocket(sock);
		expect(sshCommandArgs(remote)).toEqual([
			"-o",
			`ControlPath=${sock}`,
			"-o",
			"ControlMaster=no",
			remote,
		]);
	});

	it("invalidateMaster setzt den Socket zurück", () => {
		setControlSocket(sock);
		invalidateMaster();
		expect(sshCommandArgs(remote)).toEqual([remote]);
	});
});

describe("DEAD_MASTER", () => {
	it("erkennt Zombie-Master-Symptome", () => {
		expect(DEAD_MASTER.test("read from master failed: Broken pipe")).toBe(true);
		expect(DEAD_MASTER.test("Control socket connect(/tmp/x.sock): No such file or directory")).toBe(
			true,
		);
		expect(DEAD_MASTER.test("Control socket connect(/tmp/x.sock): Connection refused")).toBe(true);
	});

	it("schlägt bei harmlosen Meldungen nicht an", () => {
		// Nur der Mux-Socket zählt: ein TCP-„Connection refused“ (Host down) ist
		// ein anderer Fehler und soll keine Master-Recovery auslösen.
		expect(DEAD_MASTER.test("ssh: connect to host port 22: Connection refused")).toBe(false);
		expect(DEAD_MASTER.test("Everything is fine")).toBe(false);
		expect(DEAD_MASTER.test("ls: cannot access '/x': No such file or directory")).toBe(false);
	});
});

describe("isSocketAlive", () => {
	it("ruft ssh -O check mit ControlPath und ConnectTimeout auf", () => {
		expect(isSocketAlive(sock, remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"ssh",
			["-o", `ControlPath=${sock}`, "-o", "ConnectTimeout=1", "-O", "check", remote],
			{ timeout: 3000 },
		);
	});

	it("meldet false bei Exit-Code != 0", () => {
		spawnSyncMock.mockReturnValue({ status: 1 });
		expect(isSocketAlive(sock, remote)).toBe(false);
	});

	it("meldet false, wenn ssh wirft", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(isSocketAlive(sock, remote)).toBe(false);
	});
});

describe("canRoundTrip", () => {
	it("verlangt BatchMode und echten Befehl durch den Socket", () => {
		expect(canRoundTrip(sock, remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"ssh",
			[
				"-o",
				`ControlPath=${sock}`,
				"-o",
				"ControlMaster=no",
				"-o",
				"BatchMode=yes",
				"-o",
				"ConnectTimeout=3",
				remote,
				"true",
			],
			{ timeout: 5000 },
		);
	});

	it("meldet false bei Fehlschlag oder Exception", () => {
		spawnSyncMock.mockReturnValue({ status: 2 });
		expect(canRoundTrip(sock, remote)).toBe(false);

		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(canRoundTrip(sock, remote)).toBe(false);
	});
});

describe("cleanupMaster", () => {
	it("beendet den Master und entfernt den Socket", () => {
		cleanupMaster(sock, remote);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"ssh",
			["-o", `ControlPath=${sock}`, "-o", "ConnectTimeout=2", "-O", "exit", remote],
			{ timeout: 2000 },
		);
		expect(rmSyncMock).toHaveBeenCalledWith(sock, { force: true });
	});

	it("übersteht Fehler in ssh und fs", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		rmSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(() => cleanupMaster(sock, remote)).not.toThrow();
	});
});

describe("isMasterAlive", () => {
	it("ohne Socket: false, ohne ssh aufzurufen", () => {
		expect(isMasterAlive(remote)).toBe(false);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("prüft den Socket und cached das Ergebnis 2 s", () => {
		setControlSocket(sock);
		expect(isMasterAlive(remote)).toBe(true);
		expect(isMasterAlive(remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(2000);
		expect(isMasterAlive(remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("neuer Socket invalidiert den Cache", () => {
		setControlSocket(sock);
		expect(isMasterAlive(remote)).toBe(true);
		setControlSocket("/tmp/other.sock");
		spawnSyncMock.mockReturnValue({ status: 1 });
		expect(isMasterAlive(remote)).toBe(false);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});
});

describe("SSH_CONTROL_PERSIST", () => {
	it("parst die Env-Variable (Default 43200)", async () => {
		vi.resetModules();
		vi.stubEnv("SSH_CONTROL_PERSIST", "60");
		const fresh = await import("./master.ts");
		expect(fresh.SSH_CONTROL_PERSIST).toBe(60);
		vi.unstubAllEnvs();

		vi.resetModules();
		vi.stubEnv("SSH_CONTROL_PERSIST", "");
		const fresh2 = await import("./master.ts");
		expect(fresh2.SSH_CONTROL_PERSIST).toBe(43200);
		vi.unstubAllEnvs();
	});
});
