import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GUARD_GRACE_S, guardCommand, rootGuardArgs } from "./guard.ts";

// Local instead of via ssh: the remote process sees the same thing – stdin is a
// pipe, not a TTY, and "channel closed" means EOF on stdin.

let dir: string;
beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-guard-"));
});
afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

function run(remote: string) {
	const child = spawn("sh", ["-c", remote], { stdio: ["pipe", "pipe", "pipe"] });
	let output = "";
	child.stdout.on("data", (d) => (output += d));
	child.stderr.on("data", (d) => (output += d));
	const done = new Promise<{ code: number | null; output: string }>((resolve) =>
		child.on("close", (code) => resolve({ code, output })),
	);
	return { child, done };
}

const alive = (pid: number) => {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
};

async function waitFor(pred: () => boolean, ms: number) {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timeout");
		await new Promise((r) => setTimeout(r, 50));
	}
}

/** Waits until the command has written its PIDs to `pids`. */
async function readPids(file: string, n: number): Promise<number[]> {
	await waitFor(
		() => fs.existsSync(file) && fs.readFileSync(file, "utf8").trim().split(/\s+/).length >= n,
		3000,
	);
	return fs.readFileSync(file, "utf8").trim().split(/\s+/).map(Number);
}

describe("guardCommand", () => {
	it("passes through output and exit code and ends despite open stdin", async () => {
		const { done } = run(guardCommand(`echo out; echo err >&2; printf '%s' "it's"; exit 3`));
		const r = await done;
		expect(r.code).toBe(3);
		expect(r.output).toContain("out");
		expect(r.output).toContain("err");
		expect(r.output).toContain("it's");
	});

	it("gives the command /dev/null as stdin", async () => {
		const { done } = run(guardCommand(`cat; echo fertig`));
		expect((await done).output).toBe("fertig\n");
	});

	it("kills the whole process group incl. background children on stdin EOF", async () => {
		const f = path.join(dir, "pids");
		const { child, done } = run(guardCommand(`sleep 100 & echo $! $$ > ${f}; sleep 100`));
		const pids = await readPids(f, 2);
		expect(pids.every(alive)).toBe(true);

		const t0 = Date.now();
		child.stdin.end();
		const r = await done;
		expect(r.code).not.toBe(0);
		expect(r.output).toBe(""); // no job messages ("[1]- Terminated …") from bash
		expect(Date.now() - t0).toBeLessThan(1000); // watchdog does not keep the channel open
		await waitFor(() => !pids.some(alive), 1000);
	});

	it("sends KILL when TERM is ignored", async () => {
		const f = path.join(dir, "pids");
		const { child, done } = run(guardCommand(`trap '' TERM; sleep 100 & echo $! > ${f}; wait`));
		const [pid] = await readPids(f, 1);

		const t0 = Date.now();
		child.stdin.end();
		await done; // leader ignores TERM → ends only through the KILL
		expect(Date.now() - t0).toBeGreaterThanOrEqual(GUARD_GRACE_S * 1000 - 100);
		await waitFor(() => !alive(pid), 1000);
	}, 10_000);

	it("with passLine, gives the first stdin line to the command and keeps the rest open", async () => {
		const { child, done } = run(
			guardCommand(`IFS= read -r x; echo "got:$x"; read y || echo eof`, true),
		);
		child.stdin.write("secret 'pw'\n");
		const r = await done;
		expect(r.output).toBe("got:secret 'pw'\neof\n");
		expect(r.code).toBe(0);
	});
});

describe("rootGuardArgs", () => {
	it("cleans up the process group on TERM", async () => {
		const f = path.join(dir, "pids");
		const { child, done } = run(`exec ${rootGuardArgs(`sleep 100 & echo $! > ${f}; sleep 100`)}`);
		const [pid] = await readPids(f, 1);

		child.kill("SIGTERM");
		await done;
		await waitFor(() => !alive(pid), 1000);
	});

	it("passes through the exit code without a signal", async () => {
		const { done } = run(rootGuardArgs(`exit 7`));
		expect((await done).code).toBe(7);
	});
});
