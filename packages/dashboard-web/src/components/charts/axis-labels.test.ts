import { describe, expect, it } from "bun:test";
import { endEllipsis, middleEllipsis } from "./axis-labels";

describe("middleEllipsis", () => {
	it("leaves a label at or under the limit alone", () => {
		expect(middleEllipsis("codex-pro", 12)).toBe("codex-pro");
		expect(middleEllipsis("twelve-chars", 12)).toBe("twelve-chars");
	});

	it("keeps both ends of a longer label, so names that share a prefix stay apart", () => {
		const names = [
			"synthetic-account-a",
			"synthetic-account-b",
			"synthetic-account-c",
		].map((name) => middleEllipsis(name, 12));
		expect(names[0]).toBe("synth…ount-a");
		expect(new Set(names).size).toBe(3);
		for (const name of names) expect(Array.from(name)).toHaveLength(12);
	});

	it("never splits a character made of two UTF-16 units", () => {
		expect(middleEllipsis("acct-🚀🚀🚀🚀🚀🚀-x", 8)).toBe("acc…🚀🚀-x");
	});
});

describe("endEllipsis", () => {
	it("leaves a label at or under the limit alone", () => {
		expect(endEllipsis("claude-sonnet-4-5-20250929", 26)).toBe(
			"claude-sonnet-4-5-20250929",
		);
	});

	it("keeps the start of a longer label, where model ids differ", () => {
		const cut = endEllipsis("qwen3-coder-480b-a35b-instruct", 26);
		expect(cut).toBe("qwen3-coder-480b-a35b-ins…");
		expect(Array.from(cut)).toHaveLength(26);
	});

	it("never splits a character made of two UTF-16 units", () => {
		expect(endEllipsis("model-🚀🚀🚀🚀", 8)).toBe("model-🚀…");
	});
});
