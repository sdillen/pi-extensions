import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEAD_MASTER, SSH_CONTROL_PERSIST } from "./master.ts";

const { spawnSyncMock, rmSyncMock } = vi.hoisted(() => ({
	spawnSyncMock: vi.fn(),
	rmSyncMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ spawnSync: spawnSyncMock }));
vi.mock("node:fs", () => ({ rmSync: rmSyncMock }));

// Import after the vi.mock calls so that master.ts gets the mocks.
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
	it("places the socket under ~/.ssh/controlmaster", () => {
		expect(socketPathFor(remote)).toBe(
			`${process.env.HOME}/.ssh/controlmaster/user@example.org.sock`,
		);
	});

	it("replaces dangerous characters, keeps host:port", () => {
		const p = socketPathFor("usér@höst:1");
		expect(p.endsWith("/controlmaster/us_r@h_st:1.sock")).toBe(true);
	});
});

describe("sshCommandArgs", () => {
	it("returns only the remote without a socket", () => {
		expect(sshCommandArgs(remote)).toEqual([remote]);
	});

	it("rides on the ControlMaster socket once set", () => {
		setControlSocket(sock);
		expect(sshCommandArgs(remote)).toEqual([
			"-o",
			`ControlPath=${sock}`,
			"-o",
			"ControlMaster=no",
			remote,
		]);
	});

	it("invalidateMaster resets the socket", () => {
		setControlSocket(sock);
		invalidateMaster();
		expect(sshCommandArgs(remote)).toEqual([remote]);
	});
});

describe("DEAD_MASTER", () => {
	it("detects zombie master symptoms", () => {
		expect(DEAD_MASTER.test("read from master failed: Broken pipe")).toBe(true);
		expect(DEAD_MASTER.test("Control socket connect(/tmp/x.sock): No such file or directory")).toBe(
			true,
		);
		expect(DEAD_MASTER.test("Control socket connect(/tmp/x.sock): Connection refused")).toBe(true);
	});

	it("does not trigger on harmless messages", () => {
		// Only the mux socket counts: a TCP "Connection refused" (host down) is
		// a different error and must not trigger master recovery.
		expect(DEAD_MASTER.test("ssh: connect to host port 22: Connection refused")).toBe(false);
		expect(DEAD_MASTER.test("Everything is fine")).toBe(false);
		expect(DEAD_MASTER.test("ls: cannot access '/x': No such file or directory")).toBe(false);
	});
});

describe("isSocketAlive", () => {
	it("calls ssh -O check with ControlPath and ConnectTimeout", () => {
		expect(isSocketAlive(sock, remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"ssh",
			["-o", `ControlPath=${sock}`, "-o", "ConnectTimeout=1", "-O", "check", remote],
			{ timeout: 3000 },
		);
	});

	it("reports false on exit code != 0", () => {
		spawnSyncMock.mockReturnValue({ status: 1 });
		expect(isSocketAlive(sock, remote)).toBe(false);
	});

	it("reports false when ssh throws", () => {
		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(isSocketAlive(sock, remote)).toBe(false);
	});
});

describe("canRoundTrip", () => {
	it("requires BatchMode and a real command through the socket", () => {
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

	it("reports false on failure or exception", () => {
		spawnSyncMock.mockReturnValue({ status: 2 });
		expect(canRoundTrip(sock, remote)).toBe(false);

		spawnSyncMock.mockImplementation(() => {
			throw new Error("boom");
		});
		expect(canRoundTrip(sock, remote)).toBe(false);
	});
});

describe("cleanupMaster", () => {
	it("exits the master and removes the socket", () => {
		cleanupMaster(sock, remote);
		expect(spawnSyncMock).toHaveBeenCalledWith(
			"ssh",
			["-o", `ControlPath=${sock}`, "-o", "ConnectTimeout=2", "-O", "exit", remote],
			{ timeout: 2000 },
		);
		expect(rmSyncMock).toHaveBeenCalledWith(sock, { force: true });
	});

	it("survives errors in ssh and fs", () => {
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
	it("without a socket: false, without calling ssh", () => {
		expect(isMasterAlive(remote)).toBe(false);
		expect(spawnSyncMock).not.toHaveBeenCalled();
	});

	it("checks the socket and caches the result for 2 s", () => {
		setControlSocket(sock);
		expect(isMasterAlive(remote)).toBe(true);
		expect(isMasterAlive(remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(1);

		vi.advanceTimersByTime(2000);
		expect(isMasterAlive(remote)).toBe(true);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});

	it("a new socket invalidates the cache", () => {
		setControlSocket(sock);
		expect(isMasterAlive(remote)).toBe(true);
		setControlSocket("/tmp/other.sock");
		spawnSyncMock.mockReturnValue({ status: 1 });
		expect(isMasterAlive(remote)).toBe(false);
		expect(spawnSyncMock).toHaveBeenCalledTimes(2);
	});
});

describe("SSH_CONTROL_PERSIST", () => {
	it("parses the env variable (default 43200)", async () => {
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
