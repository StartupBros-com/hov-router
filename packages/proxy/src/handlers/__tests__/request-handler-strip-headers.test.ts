import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { chatGptCloudflareCookieJar } from "../../chatgpt-cloudflare-cookies";
import { applyPrivateAiTraceContext } from "../private-ai-trace-context";
import { makeProxyRequest } from "../request-handler";

/**
 * Regression for tombii#336 / Greptile P1 "Probe Secret Reaches Provider Path":
 * the internal probe secret (and the marker headers it gates) must be stripped
 * before the request is forwarded upstream, so a provider or custom endpoint
 * never receives the process-local capability secret.
 */
describe("makeProxyRequest strips internal control headers before provider forward", () => {
	let realFetch: typeof globalThis.fetch;
	let sentHeaders: Headers | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		sentHeaders = undefined;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			sentHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	it("does not forward the probe secret or markers on the headers-param path", async () => {
		const headers = new Headers({
			"x-hov-router-internal-probe-secret": "s3cr3t",
			"x-hov-router-responses-adapter-secret": "s3cr3t",
			"x-hov-router-auto-refresh": "true",
			"x-hov-router-keepalive": "true",
			"x-hov-router-guard-request-id": "signed-envelope",
			"x-hov-router-guard-correlation-secret": "must-never-be-http",
			"x-hov-router-request-id": "req-1",
			"x-hov-router-request-stream": "true",
			"x-hov-router-codex-custom-tools": "true",
			"x-hov-router-native-responses": "true",
			"x-hov-router-authenticated-caller": "apikey-1",
			"x-hov-router-exclude-providers": "codex",
			"x-hov-router-codex-continuation": "1",
			authorization: "Bearer token",
			"content-type": "application/json",
		});
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(sentHeaders?.get("x-hov-router-internal-probe-secret")).toBeNull();
		expect(
			sentHeaders?.get("x-hov-router-responses-adapter-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-hov-router-auto-refresh")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-guard-request-id")).toBeNull();
		expect(
			sentHeaders?.get("x-hov-router-guard-correlation-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-hov-router-request-id")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-request-stream")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-codex-custom-tools")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-native-responses")).toBeNull();
		// Regression for the risk the upstream port itself calls out: an
		// external caller forging this header must never have it reach the
		// provider either (see CODEX_AUTHENTICATED_CALLER_HEADER's own
		// "deleted before any outbound transport" contract in provider.ts).
		expect(sentHeaders?.get("x-hov-router-authenticated-caller")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-exclude-providers")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-codex-continuation")).toBeNull();
		// unrelated headers still forwarded
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("private correlation survives final stripping without reading the body or replacing the response", async () => {
		const previous = process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
		const accountId = "12345678-1234-4234-8234-123456789abc";
		process.env.PRIVATE_AI_TRACE_ROUTES_JSON = JSON.stringify({
			[accountId]: "https://private.example",
		});
		const response = new Response("upstream bytes", { status: 201 });
		globalThis.fetch = mock(async (input: unknown) => {
			if (!(input instanceof Request)) throw new Error("expected Request");
			sentHeaders = input.headers;
			expect(await input.text()).toBe("unchanged body");
			return response;
		}) as typeof fetch;
		try {
			const req = new Request("https://private.example/v1/chat/completions", {
				method: "POST",
				body: "unchanged body",
				headers: {
					"x-hov-router-guard-request-id": "signed-envelope",
					"x-hov-router-guard-correlation-secret": "secret",
					"x-hov-router-request-id": "internal",
					"x-hov-router-internal-probe-secret": "secret",
				},
			});
			applyPrivateAiTraceContext(
				req.headers,
				{ id: accountId, provider: "openai-compatible" },
				req.url,
				"abcdef01-2345-4678-9abc-def012345678",
				new Headers(),
			);
			expect(req.bodyUsed).toBe(false);
			expect(await makeProxyRequest(req)).toBe(response);
			expect(response.bodyUsed).toBe(false);
			expect(sentHeaders?.get("x-private-ai-request-id")).toBe(
				"abcdef01-2345-4678-9abc-def012345678",
			);
			expect(sentHeaders?.get("traceparent")).toBe(
				`00-abcdef01234546789abcdef012345678-${sentHeaders?.get("x-private-ai-attempt-id")}-01`,
			);
			for (const name of sentHeaders?.keys() ?? [])
				expect(name.startsWith("x-hov-router-")).toBe(false);
		} finally {
			if (previous === undefined)
				delete process.env.PRIVATE_AI_TRACE_ROUTES_JSON;
			else process.env.PRIVATE_AI_TRACE_ROUTES_JSON = previous;
		}
	});

	it("does not forward the probe secret on the Request-target path", async () => {
		const req = new Request("https://api.anthropic.com/v1/messages", {
			method: "POST",
			headers: {
				"x-hov-router-internal-probe-secret": "s3cr3t",
				"x-hov-router-responses-adapter-secret": "s3cr3t",
				"x-hov-router-keepalive": "true",
				"x-hov-router-guard-request-id": "signed-envelope",
				"x-hov-router-guard-correlation-secret": "must-never-be-http",
				"x-hov-router-request-id": "req-1",
				"x-hov-router-authenticated-caller": "apikey-1",
				authorization: "Bearer token",
			},
		});
		await makeProxyRequest(req);
		expect(sentHeaders?.get("x-hov-router-internal-probe-secret")).toBeNull();
		expect(
			sentHeaders?.get("x-hov-router-responses-adapter-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-hov-router-keepalive")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-guard-request-id")).toBeNull();
		expect(
			sentHeaders?.get("x-hov-router-guard-correlation-secret"),
		).toBeNull();
		expect(sentHeaders?.get("x-hov-router-request-id")).toBeNull();
		expect(sentHeaders?.get("x-hov-router-authenticated-caller")).toBeNull();
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});
});

/**
 * Confirmed finding (three adversarial reviewers): a client's own Cookie,
 * X-Real-IP, Forwarded, CDN-Loop, CF-* and X-Forwarded-* headers reached the
 * literal fetch to chatgpt.com's Codex backend unchanged, because nothing on
 * the path from the guard to the final `fetch` ever stripped them. The
 * `chatGptCloudflareCookieJar.applyCookieHeader` allowlist only governs what
 * the fork itself INJECTS into the Cookie header; it merges into whatever the
 * client already sent, so it never removes a client-forged cookie and passes
 * the client's Cookie header through completely unmodified when the jar has
 * captured nothing for that host.
 */
describe("makeProxyRequest strips client-supplied forwarding headers before every upstream fetch", () => {
	let realFetch: typeof globalThis.fetch;
	let sentHeaders: Headers | undefined;

	beforeEach(() => {
		realFetch = globalThis.fetch;
		sentHeaders = undefined;
		globalThis.fetch = mock(async (input: unknown, init?: RequestInit) => {
			sentHeaders =
				input instanceof Request
					? new Headers(input.headers)
					: new Headers(init?.headers);
			return new Response("ok", { status: 200 });
		}) as unknown as typeof globalThis.fetch;
	});

	afterEach(() => {
		globalThis.fetch = realFetch;
	});

	function clientForwardingHeaders(): Record<string, string> {
		return {
			cookie: "session=client-forged-value",
			"x-real-ip": "203.0.113.9",
			forwarded: "for=203.0.113.9;proto=https",
			"cdn-loop": "cloudflare",
			"cf-connecting-ip": "203.0.113.9",
			"cf-ipcountry": "US",
			"x-forwarded-for": "203.0.113.9",
			"x-forwarded-proto": "https",
			authorization: "Bearer token",
			"content-type": "application/json",
		};
	}

	it("strips client forwarding headers on the headers-param path (Codex target)", async () => {
		const headers = new Headers(clientForwardingHeaders());
		await makeProxyRequest(
			"https://chatgpt.com/backend-api/codex/responses",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(sentHeaders?.get("cookie")).toBeNull();
		expect(sentHeaders?.get("x-real-ip")).toBeNull();
		expect(sentHeaders?.get("forwarded")).toBeNull();
		expect(sentHeaders?.get("cdn-loop")).toBeNull();
		expect(sentHeaders?.get("cf-connecting-ip")).toBeNull();
		expect(sentHeaders?.get("cf-ipcountry")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-for")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-proto")).toBeNull();
		// unrelated headers still forwarded
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("strips client forwarding headers on the Request-target path (Codex target)", async () => {
		const req = new Request("https://chatgpt.com/backend-api/codex/responses", {
			method: "POST",
			headers: clientForwardingHeaders(),
		});
		await makeProxyRequest(req);
		expect(sentHeaders?.get("cookie")).toBeNull();
		expect(sentHeaders?.get("x-real-ip")).toBeNull();
		expect(sentHeaders?.get("forwarded")).toBeNull();
		expect(sentHeaders?.get("cdn-loop")).toBeNull();
		expect(sentHeaders?.get("cf-connecting-ip")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-for")).toBeNull();
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
	});

	it("also strips client forwarding headers for a non-Codex provider target (same choke point protects every provider)", async () => {
		const headers = new Headers(clientForwardingHeaders());
		await makeProxyRequest(
			"https://api.anthropic.com/v1/messages",
			"POST",
			headers,
			undefined,
			false,
		);
		expect(sentHeaders?.get("cookie")).toBeNull();
		expect(sentHeaders?.get("x-real-ip")).toBeNull();
		expect(sentHeaders?.get("forwarded")).toBeNull();
		expect(sentHeaders?.get("cdn-loop")).toBeNull();
		expect(sentHeaders?.get("cf-connecting-ip")).toBeNull();
		expect(sentHeaders?.get("x-forwarded-for")).toBeNull();
		// unrelated headers still forwarded -- stripping must not be overbroad
		expect(sentHeaders?.get("authorization")).toBe("Bearer token");
		expect(sentHeaders?.get("content-type")).toBe("application/json");
	});

	it("still injects the fork's own allowlisted Cloudflare cookie for chatgpt.com after stripping the client's Cookie header", async () => {
		// Seed the jar the way a real prior response would: an allowlisted
		// Cloudflare cookie captured from chatgpt.com.
		chatGptCloudflareCookieJar.captureFromResponse(
			"https://chatgpt.com/backend-api/codex/responses",
			new Response(null, {
				headers: [
					["set-cookie", "cf_clearance=fork-owned-clearance; Path=/; Secure"],
				],
			}),
		);

		const headers = new Headers({
			cookie: "session=client-forged-value",
			authorization: "Bearer token",
		});
		await makeProxyRequest(
			"https://chatgpt.com/backend-api/codex/responses",
			"POST",
			headers,
			undefined,
			false,
		);

		const outboundCookie = sentHeaders?.get("cookie");
		expect(outboundCookie).not.toBeNull();
		expect(outboundCookie).toContain("cf_clearance=fork-owned-clearance");
		// The client's forged cookie name must not survive the merge either.
		expect(outboundCookie).not.toContain("session=client-forged-value");
	});
});
