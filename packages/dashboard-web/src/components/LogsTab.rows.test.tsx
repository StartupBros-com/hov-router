import { describe, expect, it } from "bun:test";
import { queryKeys } from "../lib/query-keys";
import { LogsTab } from "./LogsTab";
import { renderPage, seedState } from "./page-state-test-helpers";

const AT = Date.parse("2026-11-13T07:00:00.000Z");
const LONG = `upstream said ${"x".repeat(400)}`;

/**
 * Looser than LogEntry on purpose: the page must cope with lowercase, unknown
 * and missing levels even though the type names only the four upper-case ones.
 */
type RawLogLine = { ts: number; level?: string; msg: string };

const ENTRIES: RawLogLine[] = [
	{ ts: AT, level: "error", msg: "lowercase error" },
	{ ts: AT + 1000, level: "WARN", msg: "upper warn" },
	{ ts: AT + 2000, level: "warning", msg: "long-form warning" },
	{ ts: AT + 3000, level: "info", msg: "lowercase info" },
	{ ts: AT + 4000, level: "DEBUG", msg: "debug line" },
	{ ts: AT + 5000, level: "trace", msg: "unknown level" },
	{ ts: AT + 6000, msg: "no level" },
	{ ts: AT + 7000, level: "critical", msg: "longer than seven letters" },
	{ ts: AT + 8000, level: "info", msg: LONG },
];

function render(entries: RawLogLine[] = ENTRIES) {
	return renderPage(<LogsTab />, (client) =>
		seedState(client, queryKeys.logHistory(), "empty", entries),
	);
}

describe("Logs rows", () => {
	it.each([
		["danger", "ERROR"],
		["warning", "WARN"],
		["warning", "WARNING"],
		["info", "INFO"],
		["neutral", "DEBUG"],
		["neutral", "TRACE"],
		["neutral", "LOG"],
		["neutral", "CRITICAL"],
	])("shows a %s-toned %s level, upper-cased", (tone, label) => {
		expect(render()).toMatch(
			new RegExp(`data-tone="${tone}"[^>]*>${label}</span>`),
		);
	});

	it("drops the raw palette colours and the bracketed level", () => {
		const html = render();
		expect(html).not.toMatch(/text-(?:yellow|green)-/);
		expect(html).not.toContain("[INFO]");
	});

	it("gives every level the same minimum width, growing past seven letters", () => {
		const levels =
			render().match(/<span[^>]*data-tone="[a-z]+"[^>]*>[A-Z]+<\/span>/g) ?? [];
		expect(levels).toHaveLength(ENTRIES.length);
		// A minimum, not a fixed width: CRITICAL must not run into its message.
		for (const level of levels) expect(level).toMatch(/\bmin-w-\[7ch\]/);
	});

	it("puts each line's time in a time element", () => {
		const html = render();
		expect(html.match(/<time\b/g)).toHaveLength(ENTRIES.length);
		expect(html).toContain('dateTime="2026-11-13T07:00:00.000Z"');
	});

	it("lets a long message wrap instead of widening the page", () => {
		const html = render();
		const row = html.slice(html.lastIndexOf("<time"));
		expect(row).toContain(LONG);
		expect(row).toMatch(/<span[^>]*min-w-0[^>]*break-words/);
	});

	it("makes the scroll area a labelled, focusable region", () => {
		// A <section> with an accessible name has the implicit role "region".
		const region =
			render().match(/<section[^>]*aria-label="Log lines"[^>]*>/)?.[0] ?? "";
		expect(region).not.toBe("");
		expect(region).toMatch(/tabindex="0"/i);
		expect(region).toContain("overflow-y-auto");
	});

	it("gives Pause, Clear and the auto-scroll label 44 px targets", () => {
		const html = render();
		for (const name of ["Pause", "Clear"]) {
			const button =
				html.match(
					new RegExp(`<button[^>]*>(?:(?!</button>).)*${name}</button>`),
				)?.[0] ?? "";
			expect(button).toContain("min-h-11");
			// The Button's gap spaces the icon; the old per-icon margin is gone.
			expect(button).not.toContain("mr-2");
		}
		expect(html).toMatch(/<label[^>]*min-h-11[^>]*>/);
	});
});
