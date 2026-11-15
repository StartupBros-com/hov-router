import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EventTime } from "./event-time";

const EVENT = Date.UTC(2026, 10, 15, 13, 42, 5);

describe("EventTime", () => {
	it("renders a time element carrying the instant and the full date", () => {
		const html = renderToStaticMarkup(
			<EventTime value={EVENT} now={EVENT} className="shrink-0" />,
		);
		expect(html).toStartWith("<time");
		expect(html).toContain('dateTime="2026-11-15T13:42:05.000Z"');
		expect(html).toContain('class="shrink-0"');
		expect(html).toMatch(/title="[^"]*2026[^"]*"/);
	});

	it("shows Unknown time instead of throwing on a bad timestamp", () => {
		for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, undefined]) {
			const html = renderToStaticMarkup(
				<EventTime value={bad as unknown as number} now={EVENT} />,
			);
			expect(html).toContain("Unknown time");
			expect(html).not.toContain("<time");
		}
	});
});
