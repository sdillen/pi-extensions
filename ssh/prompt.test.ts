import { describe, expect, it } from "vitest";
import { applySshContext, SSH_REMOTE_SECTION, sshRemoteSection } from "./prompt.ts";

const target = { remote: "user@host", remoteCwd: "/srv/app" };

describe("applySshContext", () => {
	it("sets cwd to the remote directory", () => {
		const options = { cwd: "/Users/me/project", sections: {} };
		applySshContext(options, target);
		expect(options.cwd).toBe("/srv/app");
	});

	it("adds the ssh_remote section and leaves other sections untouched", () => {
		const options = { cwd: "/Users/me/project", sections: { addendum: "extra" } };
		applySshContext(options, target);
		expect(options.sections).toEqual({
			addendum: "extra",
			[SSH_REMOTE_SECTION]: sshRemoteSection(target),
		});
	});

	it("uses a valid section name for pi", () => {
		expect(SSH_REMOTE_SECTION).toMatch(/^[a-z][a-z0-9_-]*$/);
	});
});

describe("sshRemoteSection", () => {
	it("nennt Host und Remote-Verzeichnis", () => {
		const text = sshRemoteSection(target);
		expect(text).toContain("user@host");
		expect(text).toContain("/srv/app");
	});

	it("tells the agent that local files are unreachable and sudo is needed", () => {
		const text = sshRemoteSection(target);
		expect(text).toContain("not on the local machine");
		expect(text).toContain("Local files are not accessible");
		expect(text).toContain("sudo tool");
	});
});
