import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestPayload, RequestSummary } from "../api";
import { makeRequestSummary } from "../hooks/__tests__/request-summary-fixture";
import {
	NoResponseMessage,
	PayloadBlock,
	RequestDetailsPanel,
} from "./RequestDetailsModal";
import { Dialog } from "./ui/dialog";

const AT = Date.parse("2026-11-13T07:00:00.000Z");

function payload(overrides: Partial<RequestPayload> = {}): RequestPayload {
	return {
		id: "req-302",
		request: { headers: { "content-type": "application/json" }, body: null },
		response: { status: 302, headers: { location: "/elsewhere" }, body: null },
		meta: { timestamp: AT, success: true },
		...overrides,
	};
}

function renderPanel(request: RequestPayload, summary?: RequestSummary) {
	return renderToStaticMarkup(
		<Dialog open>
			<RequestDetailsPanel
				request={request}
				effective={request}
				summary={summary}
				payloadStatus="ready"
			/>
		</Dialog>,
	);
}

/** Every `<p>…</p>` body in the markup, so nesting can be checked. */
function paragraphBodies(html: string): string[] {
	const bodies: string[] = [];
	let from = 0;
	for (;;) {
		const open = html.indexOf("<p", from);
		if (open === -1) return bodies;
		// Skip <path>, <pre> and other tags that merely start with "p".
		if (html[open + 2] !== ">" && html[open + 2] !== " ") {
			from = open + 2;
			continue;
		}
		const close = html.indexOf("</p>", open);
		bodies.push(html.slice(open, close === -1 ? undefined : close));
		from = close === -1 ? html.length : close + 4;
	}
}

describe("RequestDetailsPanel", () => {
	it("shows a 302 in the info tone, not as a failure", () => {
		const html = renderPanel(payload());
		expect(html).toMatch(/data-tone="info"[^>]*>302</);
		expect(html).not.toContain("bg-destructive");
	});

	it("puts the event time in a time element", () => {
		expect(renderPanel(payload())).toContain(
			'dateTime="2026-11-13T07:00:00.000Z"',
		);
	});

	it("shows no stray 0 when the token total is zero", () => {
		const zero = renderPanel(
			payload(),
			makeRequestSummary({ id: "req-302", totalTokens: 0 }),
		);
		expect(zero).not.toMatch(/(?:>|-->)0</);
		expect(zero).not.toContain(" tokens");

		const counted = renderPanel(
			payload(),
			makeRequestSummary({ id: "req-302", totalTokens: 1234 }),
		);
		expect(counted.replace(/<[^>]+>/g, "")).toContain(" tokens");
	});

	it("never nests a div inside a paragraph", () => {
		const html = renderPanel(
			payload(),
			makeRequestSummary({
				id: "req-302",
				model: "test-model",
				project: "demo",
				totalTokens: 1234,
				costUsd: 0.25,
				rateLimited: true,
			}),
		);
		const bodies = paragraphBodies(html);
		expect(bodies.length).toBeGreaterThan(0);
		for (const body of bodies) expect(body).not.toContain("<div");
	});

	it("marks a rate-limited request with the warning tone", () => {
		const html = renderPanel(
			payload({ response: { status: 429, headers: {}, body: null } }),
			makeRequestSummary({ id: "req-302", rateLimited: true }),
		);
		expect(html).toMatch(/data-tone="warning"[^>]*>Rate limited</);
	});

	it("gives Beautify and every tab a 44 px target, with tabs that scroll", () => {
		const html = renderPanel(payload());
		expect(html).toMatch(/<label[^>]*min-h-11[^>]*>Beautify<\/label>/);
		const tabs = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
		expect(tabs).toHaveLength(5);
		for (const tab of tabs) expect(tab).toContain("min-h-11");
		const list = html.match(/<div[^>]*role="tablist"[^>]*>/)?.[0] ?? "";
		expect(list).toContain("overflow-x-auto");
	});
});

describe("PayloadBlock", () => {
	it("names its copy button after the section, at 44 px", () => {
		const html = renderToStaticMarkup(
			<PayloadBlock
				title="Headers"
				copyLabel="Copy request headers"
				text="content-type: application/json"
			/>,
		);
		expect(html).toContain(">Headers</h3>");
		expect(html).toMatch(
			/<button[^>]*aria-label="Copy request headers"[^>]*min-h-11|<button[^>]*min-h-11[^>]*aria-label="Copy request headers"/,
		);
		expect(html).toContain("content-type: application/json</pre>");
	});
});

describe("NoResponseMessage", () => {
	it("left-aligns a long error and lets it wrap", () => {
		const error = `Upstream refused: ${"x".repeat(300)}`;
		const html = renderToStaticMarkup(<NoResponseMessage error={error} />);
		expect(html).toMatch(
			/<p[^>]*text-left[^>]*break-words|<p[^>]*break-words[^>]*text-left/,
		);
		expect(html).toContain(error);
		expect(html).toContain("No response data available");
	});

	it("says only that there is no response when there is no error", () => {
		const html = renderToStaticMarkup(<NoResponseMessage />);
		expect(html.replace(/<[^>]+>/g, "")).toBe("No response data available");
	});
});
