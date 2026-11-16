import { beforeEach, describe, expect, it, mock } from "bun:test";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { RequestPayload } from "../api";

// ConversationView builds its messages in an effect, which never runs in a
// server render, so record what the panel hands it instead.
type Bodies = { requestBody: string | null; responseBody: string | null };
const seen: Bodies[] = [];
mock.module("./ConversationView", () => ({
	ConversationView: (props: Bodies) => {
		seen.push(props);
		return <div data-conversation-view="" />;
	},
}));

// Radix renders only the active tab; draw every tab body so all three payload tabs are in the markup.
const tabsPrimitives = await import("./ui/tabs");
mock.module("./ui/tabs", () => ({
	...tabsPrimitives,
	TabsContent: ({
		children,
		value,
	}: {
		children: ReactNode;
		value: string;
	}) => <div data-tab-content={value}>{children}</div>,
}));

const { RequestDetailsPanel, resolvePayloadView } = await import(
	"./RequestDetailsModal"
);
const { Dialog } = await import("./ui/dialog");

type PayloadStatus = Parameters<typeof RequestDetailsPanel>[0]["payloadStatus"];

const AT = Date.parse("2026-11-13T07:00:00.000Z");
const ERROR = "Synthetic routing failure: every made-up route was unavailable";
const encode = (text: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const QUESTION = JSON.stringify({
	messages: [{ role: "user", content: "Synthetic question" }],
});
const ANSWER = JSON.stringify({ error: { message: "Synthetic answer" } });

/** A failed row as the list hands it over: no bodies, status and error from the summary. */
function failedRow(overrides: Partial<RequestPayload> = {}): RequestPayload {
	return {
		id: "synthetic-failed",
		request: { headers: {}, body: null },
		response: { status: 503, headers: {}, body: null },
		error: ERROR,
		meta: { timestamp: AT, success: false, bodiesOmitted: true },
		...overrides,
	};
}

/** The payload the server stores for that request; it carries no error field. */
function storedPayload(id = "synthetic-failed"): RequestPayload {
	return {
		id,
		request: {
			headers: { "x-synthetic": "request-header" },
			body: encode(QUESTION),
		},
		response: {
			status: 503,
			headers: { "x-synthetic": "response-header" },
			body: encode(ANSWER),
		},
		meta: { timestamp: AT, success: false },
	};
}

function render(
	request: RequestPayload,
	payloadStatus: PayloadStatus,
	effective: RequestPayload = request,
) {
	return renderToStaticMarkup(
		<Dialog open>
			<RequestDetailsPanel
				request={request}
				effective={effective}
				summary={undefined}
				payloadStatus={payloadStatus}
				onRetry={() => {}}
			/>
		</Dialog>,
	);
}

/** The markup of one tab body. */
function tab(html: string, value: string): string {
	const start = html.indexOf(`data-tab-content="${value}"`);
	expect(start).toBeGreaterThan(-1);
	const next = html.indexOf("data-tab-content=", start + 1);
	return html.slice(start, next === -1 ? undefined : next);
}

/** The visible text, with tags dropped and React's apostrophe escape undone. */
const text = (html: string) =>
	html.replace(/<[^>]+>/g, " ").replaceAll("&#x27;", "'");

beforeEach(() => {
	seen.length = 0;
});

describe("resolvePayloadView", () => {
	it("looks up the stored payload for a failed row from the list", () => {
		expect(resolvePayloadView(failedRow(), null, null).status).toBe("loading");
	});

	it("shows a loaded payload for a failed request and keeps the row's error", () => {
		const view = resolvePayloadView(failedRow(), storedPayload(), null);
		expect(view.status).toBe("ready");
		expect(view.effective.request?.headers).toEqual({
			"x-synthetic": "request-header",
		});
		expect(view.effective.response?.body).toBe(encode(ANSWER));
		expect(view.effective.error).toBe(ERROR);
	});

	it("ignores a payload loaded for a different request", () => {
		const view = resolvePayloadView(
			failedRow(),
			storedPayload("synthetic-other"),
			null,
		);
		expect(view.status).toBe("loading");
		expect(view.effective.request?.headers).toEqual({});
	});

	it("waits for a running request to finish before looking anything up", () => {
		const running = failedRow({
			error: undefined,
			response: null,
			meta: {
				timestamp: AT,
				success: true,
				pending: true,
				bodiesOmitted: true,
			},
		});
		expect(resolvePayloadView(running, null, null).status).toBe("pending");
	});

	it("needs no lookup when the list already handed over the bodies", () => {
		const full = { ...storedPayload(), error: ERROR };
		const view = resolvePayloadView(full, null, null);
		expect(view.status).toBe("ready");
		expect(view.effective).toBe(full);
	});

	it("reports a failed lookup only for the request it was made for", () => {
		const missing = { id: "synthetic-failed", kind: "missing" as const };
		const broken = { id: "synthetic-failed", kind: "error" as const };
		expect(resolvePayloadView(failedRow(), null, missing).status).toBe(
			"missing",
		);
		expect(resolvePayloadView(failedRow(), null, broken).status).toBe("error");
		expect(
			resolvePayloadView(failedRow(), null, {
				...missing,
				id: "synthetic-other",
			}).status,
		).toBe("loading");
	});
});

describe("RequestDetailsPanel payload states", () => {
	it("shows a failed request's stored headers and bodies with its error", () => {
		const view = resolvePayloadView(failedRow(), storedPayload(), null);
		const html = render(failedRow(), view.status, view.effective);

		const request = tab(html, "request");
		expect(request).toContain("request-header");
		expect(request).toContain("Synthetic question");

		const response = tab(html, "response");
		expect(text(response)).toContain(`Error: ${ERROR}`);
		expect(response).toContain("response-header");
		expect(response).toContain("Synthetic answer");
		expect(response.indexOf("Error:")).toBeLessThan(
			response.indexOf("response-header"),
		);

		expect(seen).toEqual([{ requestBody: QUESTION, responseBody: ANSWER }]);
		expect(html).toMatch(/data-tone="danger"[^>]*>503</);
	});

	it("says no payload is stored on every payload tab after a 404, keeping the error", () => {
		const html = render(failedRow(), "missing");
		for (const value of ["conversation", "request", "response"]) {
			const body = text(tab(html, value));
			expect(body).toContain("No payload stored for this request");
			expect(body).toContain("Payload storage may be off");
		}
		expect(html).not.toContain(">{}</pre>");
		expect(html).not.toContain("Loading payload");
		expect(text(tab(html, "response"))).toContain(`Error: ${ERROR}`);
		expect(seen).toHaveLength(0);
	});

	it("offers Retry in an alert on every payload tab when the lookup fails", () => {
		const html = render(failedRow(), "error");
		for (const value of ["conversation", "request", "response"]) {
			const body = tab(html, value);
			expect(body).toContain('role="alert"');
			expect(text(body)).toContain("Couldn't load the stored payload");
			expect(body).toMatch(/<button[^>]*>Retry<\/button>/);
		}
		expect(html).not.toContain(">{}</pre>");
		expect(html).not.toContain("Loading payload");
		expect(text(tab(html, "response"))).toContain(`Error: ${ERROR}`);
	});

	it("shows a loading status, not placeholder headers, while the lookup runs", () => {
		const html = render(failedRow(), "loading");
		for (const value of ["conversation", "request", "response"]) {
			const body = tab(html, value);
			expect(body).toContain('role="status"');
			expect(text(body)).toContain("Loading payload");
		}
		expect(html).not.toContain(">{}</pre>");
	});

	it("shows no placeholder headers while the request is still running", () => {
		const running = failedRow({
			error: undefined,
			response: null,
			meta: {
				timestamp: AT,
				success: true,
				pending: true,
				bodiesOmitted: true,
			},
		});
		const html = render(running, "pending");
		for (const value of ["conversation", "request", "response"]) {
			expect(text(tab(html, value))).toContain("Request still running");
		}
		expect(html).not.toContain(">{}</pre>");
		expect(seen).toHaveLength(0);
	});

	it("keeps genuinely empty stored headers visible once loaded", () => {
		const stored = storedPayload();
		const empty: RequestPayload = {
			...stored,
			request: { headers: {}, body: stored.request?.body ?? null },
		};
		const view = resolvePayloadView(failedRow(), empty, null);
		expect(
			tab(render(failedRow(), view.status, view.effective), "request"),
		).toContain(">{}</pre>");
	});
});
