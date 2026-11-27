import { afterEach, describe, expect, it, mock } from "bun:test";
import { handleProxy } from "../proxy";

const ENV_KEYS = [
	"HOV_ROUTER_DISTRIBUTION",
	"HOV_ROUTER_VERSION",
	"HOV_ROUTER_GIT_SHA",
	"HOV_ROUTER_GIT_REF",
	"HOV_ROUTER_SOURCE_SHA",
	"HOV_ROUTER_SOURCE_REF",
	"HOV_ROUTER_PRODUCER",
	"HOV_ROUTER_ARTIFACT_MODE",
	"HOV_ROUTER_UPDATE_CHANNEL",
] as const;
const originalFetch = globalThis.fetch;
const savedEnv = Object.fromEntries(
	ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

function restoreEnv(): void {
	for (const key of ENV_KEYS) {
		if (savedEnv[key] === undefined) delete process.env[key];
		else process.env[key] = savedEnv[key];
	}
}

async function checkPackageManager(): Promise<Response> {
	const request = new Request("http://proxy.local/api/system/package-manager");
	return handleProxy(
		request,
		new URL(request.url),
		{} as Parameters<typeof handleProxy>[2],
	);
}

afterEach(() => {
	restoreEnv();
	globalThis.fetch = originalFetch;
});

describe("/api/system/package-manager", () => {
	it("remains an unauthenticated resolver-only compatibility route", async () => {
		for (const [name, evidence, expected] of [
			[
				"valid managed evidence",
				{
					HOV_ROUTER_DISTRIBUTION: "v1:startupbros-managed-source",
					HOV_ROUTER_GIT_SHA: "abcdef1234567890abcdef1234567890abcdef12",
					HOV_ROUTER_GIT_REF: "refs/heads/main",
					HOV_ROUTER_SOURCE_SHA: "abcdef1234567890abcdef1234567890abcdef12",
					HOV_ROUTER_SOURCE_REF: "refs/heads/main",
					HOV_ROUTER_PRODUCER: "startupbros",
					HOV_ROUTER_ARTIFACT_MODE: "managed-source",
				},
				{
					identity: "v1:startupbros-managed-source",
					producer: "startupbros",
					artifactMode: "managed-source",
					proven: true,
					reason: "proven_non_actionable",
				},
			],
			[
				"absent evidence",
				{},
				{
					identity: null,
					producer: null,
					artifactMode: null,
					proven: false,
					reason: "unknown_distribution",
				},
			],
			[
				"invalid evidence",
				{
					HOV_ROUTER_DISTRIBUTION: "v1:tombii-ghcr-docker",
					HOV_ROUTER_GIT_SHA: "short",
					HOV_ROUTER_GIT_REF: "refs/tags/v1.0.0",
				},
				{
					identity: "v1:tombii-ghcr-docker",
					producer: "tombii",
					artifactMode: "docker",
					proven: false,
					reason: "invalid_source_sha",
				},
			],
		] as const) {
			restoreEnv();
			Object.assign(process.env, evidence);
			let fetches = 0;
			globalThis.fetch = mock(async () => {
				fetches += 1;
				return new Response("unexpected");
			}) as unknown as typeof fetch;

			const response = await checkPackageManager();
			expect(response.status, name).toBe(200);
			expect(await response.json(), name).toEqual({ provenance: expected });
			expect(fetches, name).toBe(0);
		}
	});
});
