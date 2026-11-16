import { beforeEach, describe, expect, it, mock } from "bun:test";
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

const { RequestDetailsPanel } = await import("./RequestDetailsModal");
const { Dialog } = await import("./ui/dialog");

const AT = Date.parse("2026-11-13T07:00:00.000Z");
const encode = (text: string) =>
	btoa(String.fromCharCode(...new TextEncoder().encode(text)));
const REQUEST_BODY = encode(
	JSON.stringify({
		messages: [{ role: "user", content: "Synthetic question" }],
	}),
);

function payload(overrides: Partial<RequestPayload> = {}): RequestPayload {
	return {
		id: "synthetic-request",
		request: { headers: {}, body: null },
		response: null,
		meta: { timestamp: AT, success: true },
		...overrides,
	};
}

function render(request: RequestPayload, payloadMissing = false) {
	return renderToStaticMarkup(
		<Dialog open>
			<RequestDetailsPanel
				request={request}
				effective={request}
				summary={undefined}
				needsHydration={false}
				payloadMissing={payloadMissing}
			/>
		</Dialog>,
	);
}

beforeEach(() => {
	seen.length = 0;
});

describe("RequestDetailsPanel conversation tab", () => {
	it("says no payload is stored when the payload lookup answered 404", () => {
		const html = render(payload(), true);
		expect(html).toContain("No payload stored for this request");
		expect(seen).toHaveLength(0);
		expect(html).not.toContain("No data");
	});

	it("hands a missing response body over as null, never as the text No data", () => {
		render(
			payload({
				request: { headers: {}, body: REQUEST_BODY },
				response: null,
				error: "Synthetic upstream failure",
				meta: { timestamp: AT, success: false },
			}),
		);
		expect(seen).toEqual([
			{
				requestBody: JSON.stringify({
					messages: [{ role: "user", content: "Synthetic question" }],
				}),
				responseBody: null,
			},
		]);
	});

	it("hands both bodies over as null when neither was captured", () => {
		const html = render(payload());
		expect(seen).toEqual([{ requestBody: null, responseBody: null }]);
		expect(html).not.toContain("No payload stored for this request");
	});
});
