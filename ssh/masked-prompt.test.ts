import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { MaskedPasswordPrompt } from "./index.ts";

const WIDTH = 80;

function render(raw: string, cursor?: number, focused = true): string[] {
	const prompt = new MaskedPasswordPrompt("sudo password for host", () => {});
	prompt.focused = focused;
	for (const ch of raw) prompt.handleInput(ch);
	if (cursor !== undefined) {
		prompt.handleInput("\x1b[H"); // cursor to line start
		for (let i = 0; i < cursor; i++) prompt.handleInput("\x1b[C");
	}
	return prompt.render(WIDTH);
}

describe("MaskedPasswordPrompt render", () => {
	it("keeps every line of the box at the same visible width", () => {
		const cases: [string, number | undefined][] = [
			["", undefined],
			["abc", undefined],
			["abc", 0],
			["abc", 1],
			["x".repeat(20), 10],
			["x".repeat(55), undefined],
			["x".repeat(100), undefined],
			["x".repeat(100), 3],
		];
		for (const [raw, cursor] of cases) {
			const lines = render(raw, cursor);
			const widths = lines.map((l) => visibleWidth(l));
			expect(new Set(widths).size, `raw=${raw.length} cursor=${cursor}`).toBe(1);
		}
	});

	it("closes the body line with the right border at the frame width", () => {
		const [top, , , body] = render("");
		expect(visibleWidth(body)).toBe(visibleWidth(top));
		expect(body.endsWith("│")).toBe(true);
	});

	it("never shows the raw password", () => {
		const lines = render("hunter2");
		expect(lines.join("\n")).not.toContain("hunter2");
		expect(lines.join("\n")).toContain("*******");
	});
});
