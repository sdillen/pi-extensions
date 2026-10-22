import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import sshExtension from "./index.ts";

// Registers the extension against a minimal fake pi and returns the tools it registers.
function registeredTools() {
	const tools = new Map<string, { executionMode?: string }>();
	const fakePi = {
		registerFlag() {},
		registerTool(def: { name: string; executionMode?: string }) {
			tools.set(def.name, def);
		},
		on() {},
		getFlag() {
			return undefined;
		},
		getActiveTools: () => [],
		setActiveTools() {},
	} as unknown as ExtensionAPI;
	sshExtension(fakePi);
	return tools;
}

describe("sudo tool registration", () => {
	it("runs sequentially so parallel sudo calls share one password prompt", () => {
		expect(registeredTools().get("sudo")?.executionMode).toBe("sequential");
	});

	it("leaves the bash tool on the default (parallel) execution mode", () => {
		expect(registeredTools().get("bash")?.executionMode).toBeUndefined();
	});
});
