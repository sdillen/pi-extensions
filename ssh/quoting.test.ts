import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { shq } from "./guard.ts";
import { createRemoteReadOps, createRemoteWriteOps } from "./index.ts";

// Remote paths are passed through a POSIX shell. These names must reach the
// shell verbatim: no variable expansion, no command substitution, no quote breakage.
const TRICKY = [
	"report$draft.txt",
	"a`id`b.txt",
	"a$(id)b.txt",
	"it's.txt",
	'say "hi".txt',
	"back\\slash.txt",
];

let dir: string;
let origPath: string | undefined;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "shq-"));
	origPath = process.env.PATH;
});

afterEach(() => {
	process.env.PATH = origPath;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("shq", () => {
	it.each(TRICKY)("passes %s to the shell unchanged", (name) => {
		const r = spawnSync("sh", ["-c", `printf %s ${shq(name)}`], { encoding: "utf8" });
		expect(r.stdout).toBe(name);
	});

	it("does not execute command substitutions in file names", () => {
		const name = "a`touch pwned`b.txt";
		const r = spawnSync("sh", ["-c", `cd ${shq(dir)} && echo x > ${shq(name)}`], {
			encoding: "utf8",
		});
		expect(r.status).toBe(0);
		expect(fs.existsSync(path.join(dir, "pwned"))).toBe(false);
		expect(fs.existsSync(path.join(dir, name))).toBe(true);
	});
});

// The remote ops run `ssh <host> <command>`. A fake `ssh` on PATH executes the
// command locally with `sh -c`, so the real command strings are exercised.
describe("remote ops via fake ssh", () => {
	beforeEach(() => {
		const bin = path.join(dir, "bin");
		fs.mkdirSync(bin);
		const fake = path.join(bin, "ssh");
		fs.writeFileSync(fake, '#!/bin/sh\nfor last; do :; done\nexec sh -c "$last"\n');
		fs.chmodSync(fake, 0o755);
		process.env.PATH = `${bin}:${origPath}`;
		fs.mkdirSync(path.join(dir, "work"));
	});

	const work = () => path.join(dir, "work");

	it.each(TRICKY)("writes %s with the literal name", async (name) => {
		const ops = createRemoteWriteOps("fake-host", work(), work());
		await ops.writeFile(path.join(work(), name), "new");
		expect(fs.readFileSync(path.join(work(), name), "utf8")).toBe("new");
	});

	it("does not touch report.txt when a variable in the name is unset", async () => {
		fs.writeFileSync(path.join(work(), "report.txt"), "original");
		const ops = createRemoteWriteOps("fake-host", work(), work());
		await ops.writeFile(path.join(work(), "report$SHQ_UNSET_TEST_VAR.txt"), "new");
		expect(fs.readFileSync(path.join(work(), "report.txt"), "utf8")).toBe("original");
		expect(fs.readFileSync(path.join(work(), "report$SHQ_UNSET_TEST_VAR.txt"), "utf8")).toBe("new");
	});

	it("writes files larger than the per-argument limit", async () => {
		const content = "a".repeat(300 * 1024);
		const ops = createRemoteWriteOps("fake-host", work(), work());
		await ops.writeFile(path.join(work(), "big.txt"), content);
		expect(fs.readFileSync(path.join(work(), "big.txt"), "utf8")).toBe(content);
	});

	it("reads binary content byte-exact", async () => {
		const bytes = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
		fs.writeFileSync(path.join(work(), "bin.dat"), bytes);
		const ops = createRemoteReadOps("fake-host", work(), work());
		expect(await ops.readFile(path.join(work(), "bin.dat"))).toEqual(bytes);
	});

	it("rejects when the remote read fails", async () => {
		const ops = createRemoteReadOps("fake-host", work(), work());
		await expect(ops.readFile(path.join(work(), "missing.txt"))).rejects.toThrow(/read failed/);
	});

	it("maps the local cwd prefix to the remote cwd", async () => {
		const ops = createRemoteWriteOps("fake-host", work(), "/nonexistent-local");
		await ops.writeFile("/nonexistent-local/x.txt", "mapped");
		expect(fs.readFileSync(path.join(work(), "x.txt"), "utf8")).toBe("mapped");
	});

	it("keeps `$&` in the remote cwd literal", async () => {
		const remoteCwd = path.join(work(), "a$&b");
		fs.mkdirSync(remoteCwd);
		const ops = createRemoteWriteOps("fake-host", remoteCwd, "/nonexistent-local");
		await ops.writeFile("/nonexistent-local/x.txt", "literal");
		expect(fs.readFileSync(path.join(remoteCwd, "x.txt"), "utf8")).toBe("literal");
	});
});
