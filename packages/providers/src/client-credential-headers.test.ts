import { describe, expect, it } from "bun:test";
import { BaseProvider, getProvider, listProviders } from "./index";

/**
 * A client authenticates to the router with the router's own API key, in
 * `x-api-key` or `Authorization`. When the router dispatches on a stored
 * account, that key must not travel upstream: the provider (or a custom
 * endpoint) has no business seeing it.
 *
 * Providers that speak the Anthropic wire format already dropped both headers.
 * The OpenAI-compatible family and the base default dropped only
 * `Authorization`, so a client `x-api-key` reached the provider. This runs over
 * every registered provider so a new one cannot reintroduce the gap.
 */
const CLIENT_KEY = "btr-CLIENT-ROUTER-KEY-SENTINEL";

function clientHeaders(): Headers {
	return new Headers({
		"x-api-key": CLIENT_KEY,
		authorization: `Bearer ${CLIENT_KEY}`,
		"content-type": "application/json",
	});
}

function headersCarrying(headers: Headers, needle: string): string[] {
	const carrying: string[] = [];
	headers.forEach((value, name) => {
		if (value.includes(needle)) carrying.push(name);
	});
	return carrying;
}

type CredentialShape = readonly [
	label: string,
	accessToken?: string,
	apiKey?: string,
];

// The argument shapes the dispatcher sends for a stored account
// (`plan.prepareHeaders(headers, accessToken, account.api_key || undefined)`,
// with the token from `getValidAccessToken`), plus the key-only direct call.
const STORED_ACCOUNT_SHAPES: ReadonlyArray<CredentialShape> = [
	["an OAuth access token", "provider-access-token", undefined],
	// An API-key account: the token resolver answers "" and the key rides along.
	["an API key beside an empty access token", "", "provider-api-key"],
	// The API-key providers the resolver knows by name get the key as both.
	["the API key as both arguments", "provider-api-key", "provider-api-key"],
	[
		"an access token and an API key",
		"provider-access-token",
		"provider-api-key",
	],
	["a provider API key alone", undefined, "provider-api-key"],
];

// BaseProvider and the OpenAI-compatible family treat any argument that is not
// `undefined` as the router supplying credentials, empty strings included.
const EMPTY_CREDENTIAL_SHAPES: ReadonlyArray<CredentialShape> = [
	["an empty access token", "", undefined],
	["an empty API key", undefined, ""],
];

describe("client credentials never travel upstream on a stored account", () => {
	const providerNames = listProviders();

	it("covers every registered provider", () => {
		expect(providerNames.length).toBeGreaterThanOrEqual(18);
	});

	for (const name of providerNames) {
		for (const [label, accessToken, apiKey] of STORED_ACCOUNT_SHAPES) {
			it(`${name}: drops the client's key when dispatching with ${label}`, () => {
				const provider = getProvider(name);
				if (!provider) throw new Error(`provider ${name} is not registered`);

				const prepared = provider.prepareHeaders(
					clientHeaders(),
					accessToken,
					apiKey,
				);

				expect(headersCarrying(prepared, CLIENT_KEY)).toEqual([]);
			});
		}
	}
});

// No registered provider uses BaseProvider's own prepareHeaders today, but a
// new provider that extends it without overriding inherits this default.
class DefaultHeadersProvider extends BaseProvider {
	name = "default-headers";
	async refreshToken(): Promise<never> {
		throw new Error("not used");
	}
	buildUrl(): string {
		return "http://localhost/unused";
	}
}

describe("BaseProvider's default prepareHeaders", () => {
	for (const [label, accessToken, apiKey] of [
		...STORED_ACCOUNT_SHAPES,
		...EMPTY_CREDENTIAL_SHAPES,
	]) {
		it(`drops the client's key when dispatching with ${label}`, () => {
			const prepared = new DefaultHeadersProvider().prepareHeaders(
				clientHeaders(),
				accessToken,
				apiKey,
			);

			expect(headersCarrying(prepared, CLIENT_KEY)).toEqual([]);
		});
	}
});

describe("the OpenAI-compatible family with an empty stored credential", () => {
	for (const name of ["openai-compatible", "kilo", "xai"]) {
		for (const [label, accessToken, apiKey] of EMPTY_CREDENTIAL_SHAPES) {
			it(`${name}: drops the client's key when dispatching with ${label}`, () => {
				const provider = getProvider(name);
				if (!provider) throw new Error(`provider ${name} is not registered`);

				const prepared = provider.prepareHeaders(
					clientHeaders(),
					accessToken,
					apiKey,
				);

				expect(headersCarrying(prepared, CLIENT_KEY)).toEqual([]);
			});
		}
	}
});

// With no stored account the router forwards the request as it came, and the
// client's own credentials are the only ones there are. That stays as it was.
describe("passthrough with no stored credentials", () => {
	const passthroughProviders: ReadonlyArray<
		readonly [label: string, prepare: (headers: Headers) => Headers]
	> = [
		[
			"openai-compatible",
			(headers) => {
				const provider = getProvider("openai-compatible");
				if (!provider) throw new Error("openai-compatible is not registered");
				return provider.prepareHeaders(headers, undefined, undefined);
			},
		],
		[
			"BaseProvider default",
			(headers) =>
				new DefaultHeadersProvider().prepareHeaders(
					headers,
					undefined,
					undefined,
				),
		],
	];

	for (const [label, prepare] of passthroughProviders) {
		it(`${label}: keeps the client's own authorization and x-api-key`, () => {
			const prepared = prepare(clientHeaders());

			expect(prepared.get("authorization")).toBe(`Bearer ${CLIENT_KEY}`);
			expect(prepared.get("x-api-key")).toBe(CLIENT_KEY);
		});
	}
});
