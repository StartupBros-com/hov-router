import { describe, expect, it } from "bun:test";
import type { RequestPayload } from "../api";
import { API_LIMITS } from "../constants";
import { makeRequestSummary } from "../hooks/__tests__/request-summary-fixture";
import { queryKeys } from "../lib/query-keys";
import { renderPage } from "./page-state-test-helpers";
import { RequestsTab } from "./RequestsTab";

// Friday 2026-11-13 07:00 UTC is 15:00 in Singapore: inside Z.ai peak hours.
const AT = Date.parse("2026-11-13T07:00:00.000Z");
const LONG_ERROR = `Upstream refused the request: ${"x".repeat(400)}`;

function request(
	id: string,
	status: number | null,
	meta: Partial<RequestPayload["meta"]> = {},
	error?: string,
): RequestPayload {
	return {
		id,
		request: { headers: {}, body: null },
		response: status === null ? null : { status, headers: {}, body: null },
		...(error ? { error } : {}),
		meta: {
			timestamp: AT,
			method: "POST",
			path: "/v1/messages",
			success: status !== null && status < 400,
			...meta,
		},
	};
}

const REQUESTS = [
	request("ok-200", 200, { accountName: "zai-1" }),
	request("redirect-302", 302),
	request("limited-429", 429, { rateLimited: true }),
	request("failed-500", 500),
	request("pending-row", null, { pending: true, success: undefined }),
	request("no-response", null, {}, LONG_ERROR),
	request("billed-overage", 200),
	request("billed-plan", 200),
	request("combo-row", 200),
];

const SUMMARIES = [
	makeRequestSummary({ id: "billed-overage", billingType: "overage" }),
	makeRequestSummary({ id: "billed-plan", billingType: "plan" }),
	makeRequestSummary({ id: "combo-row", comboName: "fast-pair" }),
];

function renderRows() {
	const html = renderPage(<RequestsTab />, (client) => {
		client.setQueryData(queryKeys.requests(API_LIMITS.requestsDetail), {
			requests: REQUESTS,
			detailsMap: SUMMARIES,
		});
		client.setQueryData(queryKeys.accounts(), [
			{ id: "zai-id", name: "zai-1", provider: "zai" },
		]);
	});
	const rows = new Map<string, string>();
	for (const chunk of html.split('data-request-id="').slice(1)) {
		rows.set(chunk.slice(0, chunk.indexOf('"')), chunk);
	}
	return { html, rows };
}

function row(rows: Map<string, string>, id: string) {
	const markup = rows.get(id);
	if (!markup) throw new Error(`row ${id} not rendered`);
	return markup;
}

describe("Requests rows", () => {
	it("marks every row with its request id", () => {
		const { rows } = renderRows();
		expect([...rows.keys()]).toEqual(REQUESTS.map((r) => r.id));
	});

	it.each([
		["ok-200", "200", "success"],
		["redirect-302", "302", "info"],
		["limited-429", "429", "warning"],
		["failed-500", "500", "danger"],
		["pending-row", "Pending", "neutral"],
		["no-response", "No response", "danger"],
	])("%s shows its status as a %s pill", (id, text, tone) => {
		const markup = row(renderRows().rows, id);
		expect(markup).toContain(`data-tone="${tone}"`);
		expect(markup).toContain(`>${text}</span>`);
	});

	it("does not mark a pending request as failed", () => {
		const markup = row(renderRows().rows, "pending-row");
		expect(markup).not.toContain("border-destructive");
		expect(markup).toContain("motion-reduce:animate-none");
	});

	it("shows when each request happened as a machine-readable time", () => {
		const { rows } = renderRows();
		expect(rows.size).toBe(REQUESTS.length);
		for (const id of rows.keys()) {
			expect(row(rows, id)).toContain('dateTime="2026-11-13T07:00:00.000Z"');
		}
	});

	it("clamps a long error to two lines and keeps the full text in the tooltip", () => {
		const markup = row(renderRows().rows, "no-response");
		expect(markup).toContain("line-clamp-2");
		expect(markup).toContain("break-words");
		expect(markup).toContain(`title="${LONG_ERROR}"`);
		expect(markup).toContain('<span class="sr-only">Error: </span>');
	});

	it("explains peak hours instead of only saying Peak", () => {
		const markup = row(renderRows().rows, "ok-200");
		expect(markup).toContain(
			'title="Sent during Z.ai peak hours (Mon–Fri 14:00–18:00 Singapore time)"',
		);
		expect(markup).toMatch(/data-tone="info"[^>]*>Peak</);
	});

	it("shows billing and rate limiting as pills in the shared tones", () => {
		const { rows } = renderRows();
		expect(row(rows, "billed-overage")).toMatch(
			/data-tone="warning"[^>]*>Overage</,
		);
		expect(row(rows, "billed-plan")).toMatch(/data-tone="neutral"[^>]*>Plan</);
		expect(row(rows, "limited-429")).toMatch(
			/data-tone="warning"[^>]*>Rate limited</,
		);
		expect(row(rows, "combo-row")).toContain("Combo: fast-pair");
	});

	it("uses no raw palette colours in the list", () => {
		const { html } = renderRows();
		expect(html).not.toMatch(
			/\b(?:border|text|bg)-(?:purple|orange|teal|green|yellow|red)-\d/,
		);
	});

	it("gives the row actions names and 44 px targets", () => {
		const markup = row(renderRows().rows, "ok-200");
		expect(markup).toContain('aria-label="View request details"');
		expect(markup).toContain('title="View Details"');
		expect(markup).toContain('aria-label="Copy request as JSON"');
		expect(markup).toContain('title="Copy as JSON"');
		expect(markup.match(/h-11 w-11/g)?.length).toBeGreaterThanOrEqual(2);
	});

	it("tells assistive tech whether the filter panel is open", () => {
		const { html } = renderRows();
		expect(html).toMatch(/<button[^>]*aria-expanded="false"[^>]*>.*?Filters/s);
		expect(html).toContain('aria-label="Refresh requests"');
	});
});
