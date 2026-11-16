import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { activeRequestFilters } from "../../lib/request-filters";
import { ActiveFilterBar } from "./ActiveFilterBar";
import { FilterChip } from "./FilterChip";
import { RequestStatusPill } from "./RequestStatusPill";

describe("RequestStatusPill", () => {
	it("shows the status number in its tone", () => {
		const html = renderToStaticMarkup(
			<RequestStatusPill statusCode={302} pending={false} isError={false} />,
		);
		expect(html).toContain('data-tone="info"');
		expect(html).toContain(">302<");
	});

	it("shows Pending and No response when there is no status", () => {
		expect(
			renderToStaticMarkup(
				<RequestStatusPill statusCode={undefined} pending isError />,
			),
		).toContain('data-tone="neutral"');
		const failed = renderToStaticMarkup(
			<RequestStatusPill statusCode={undefined} pending={false} isError />,
		);
		expect(failed).toContain('data-tone="danger"');
		expect(failed).toContain(">No response<");
	});
});

describe("FilterChip", () => {
	it("is one button that names the filter it removes", () => {
		const html = renderToStaticMarkup(
			<FilterChip label="Account" value="max-primary" onRemove={() => {}} />,
		);
		expect(html.match(/<button/g)).toHaveLength(1);
		expect(html).toContain('aria-label="Remove filter Account: max-primary"');
		expect(html).toContain("min-h-11");
		expect(html.replace(/<[^>]+>/g, "")).toBe("Account: max-primary");
		// The X is decoration; the button's name says what it does.
		expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
	});
});

describe("ActiveFilterBar", () => {
	const filters = activeRequestFilters(
		{
			account: "max-primary",
			agent: "all",
			apiKey: "all",
			statusCodes: new Set<string>(),
			dateFrom: "2026-11-14T20:00",
			dateTo: "2026-11-15T09:30",
		},
		// Local noon on Nov 15, so the To time reads as today in any zone.
		{ locale: "en-US", now: new Date("2026-11-15T12:00").getTime() },
	);

	it("renders nothing when no filter is on", () => {
		expect(
			renderToStaticMarkup(
				<ActiveFilterBar
					filters={[]}
					shown={9}
					total={9}
					onRemove={() => {}}
					onClearAll={() => {}}
				/>,
			),
		).toBe("");
	});

	it("labels each chip and the applied range, with a 44 px Clear all", () => {
		const html = renderToStaticMarkup(
			<ActiveFilterBar
				filters={filters}
				shown={3}
				total={9}
				onRemove={() => {}}
				onClearAll={() => {}}
			/>,
		);
		const text = html.replace(/<[^>]+>/g, "");
		expect(html).toContain('aria-label="Remove filter Account: max-primary"');
		expect(html).toContain(
			'aria-label="Remove filter Date: Nov 14, 8:00 PM – 9:30 AM"',
		);
		expect(text).toContain("Account: max-primary");
		expect(text).toContain("Date: Nov 14, 8:00 PM – 9:30 AM");
		expect(text).toContain("3 of 9 requests");
		expect(html).toMatch(/<button[^>]*min-h-11[^>]*>Clear all<\/button>/);
	});
});
