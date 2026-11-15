/**
 * The billing label a request row gets when nothing more specific decides it:
 * the response carries no overage header and the account sets no billing type.
 * Dashboard and analytics split plan cost from pay-per-use cost on this label.
 */
import { afterAll, beforeAll, describe, expect, it, mock } from "bun:test";
import "@better-ccflare/core";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
import { listProviders } from "@better-ccflare/providers";
import type { RequestResponse } from "@better-ccflare/types";
import type { StartMessage } from "../worker-messages";

// Isolate the pricing catalogue: these fixtures must never fetch models.dev.
const actualCore = await import("@better-ccflare/core");
mock.module("@better-ccflare/core", () => ({
	...actualCore,
	isModelPriced: async () => false,
	estimateCostUSD: async () => 0,
}));
afterAll(() => mock.module("@better-ccflare/core", () => actualCore));
const { UsageCollector } = await import("../usage-collector");

const REPLY = Buffer.from(
	JSON.stringify({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "fixture-model",
		content: [{ type: "text", text: "ok" }],
		usage: { input_tokens: 3, output_tokens: 2 },
	}),
).toString("base64");

interface Recorded {
	/** `requests.billing_type` as stored. */
	stored: string | null;
	/** The label on the live summary event the Requests page renders. */
	live: string | undefined;
}

let db: DatabaseOperations;
let writer: AsyncDbWriter;
let collector: InstanceType<typeof UsageCollector>;
const summaries = new Map<string, RequestResponse>();
let nextRequest = 0;

beforeAll(() => {
	// Always this fixture's own SQLite database, even with an ambient
	// DATABASE_URL.
	const ambientUrl = process.env.DATABASE_URL;
	try {
		delete process.env.DATABASE_URL;
		db = new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
	writer = new AsyncDbWriter();
	collector = new UsageCollector(
		db,
		writer,
		() => false,
		(summary) => summaries.set(summary.id, summary),
	);
});

afterAll(async () => {
	collector.dispose();
	await writer.dispose();
	await db.close();
});

/** Record one successful non-streaming reply and read its label back. */
async function record(
	overrides: Pick<StartMessage, "providerName"> &
		Partial<Pick<StartMessage, "accountBillingType" | "responseHeaders">>,
): Promise<Recorded> {
	nextRequest += 1;
	const requestId = `request-${nextRequest}`;
	collector.handleStart({
		type: "start",
		messageId: `message-${nextRequest}`,
		requestId,
		accountId: null,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "application/json" },
		isStream: false,
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: null,
		accountName: null,
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		...overrides,
	});
	await collector.handleEnd({
		type: "end",
		requestId,
		success: true,
		responseBody: REPLY,
	});
	await collector.drain();
	const row = await db
		.getAdapter()
		.get<{ billing_type: string | null }>(
			"SELECT billing_type FROM requests WHERE id = ?",
			[requestId],
		);
	expect(row).not.toBeNull();
	return {
		stored: row?.billing_type ?? null,
		live: summaries.get(requestId)?.billingType,
	};
}

describe("default billing label", () => {
	it("labels every built-in provider plan or api when the account sets nothing", async () => {
		// The names come from the registered provider instances: those are the
		// strings the proxy hands the recorder as `providerName`.
		const stored: Record<string, string | null> = {};
		for (const providerName of listProviders().sort()) {
			stored[providerName] = (await record({ providerName })).stored;
		}

		expect(stored).toEqual({
			"alibaba-coding-plan": "plan",
			anthropic: "plan",
			"anthropic-compatible": "api",
			bedrock: "api",
			codex: "plan",
			deepseek: "api",
			kilo: "api",
			meta: "api",
			minimax: "api",
			nanogpt: "api",
			ollama: "plan",
			"ollama-cloud": "plan",
			"openai-compatible": "api",
			openrouter: "api",
			qwen: "plan",
			"vertex-ai": "api",
			xai: "plan",
			zai: "plan",
		});
	});

	it("labels an xAI request plan on the stored row and the live summary", async () => {
		// A Grok account signs in with the Grok CLI and draws on a credit pool
		// that resets weekly. It has no API key and no billing type of its own.
		expect(await record({ providerName: "xai" })).toEqual({
			stored: "plan",
			live: "plan",
		});
	});

	it("still labels an xAI request api when its account says api", async () => {
		expect(
			await record({ providerName: "xai", accountBillingType: "api" }),
		).toEqual({ stored: "api", live: "api" });
	});

	it("labels a provider it does not know api", async () => {
		expect(await record({ providerName: "not-a-provider" })).toEqual({
			stored: "api",
			live: "api",
		});
	});

	it("lets the account's own billing type override the provider default", async () => {
		expect(
			await record({ providerName: "anthropic", accountBillingType: "api" }),
		).toEqual({ stored: "api", live: "api" });
		expect(
			await record({ providerName: "openrouter", accountBillingType: "plan" }),
		).toEqual({ stored: "plan", live: "plan" });
	});

	it("lets an overage header override both", async () => {
		expect(
			await record({
				providerName: "anthropic",
				accountBillingType: "plan",
				responseHeaders: {
					"content-type": "application/json",
					"anthropic-ratelimit-unified-overage-in-use": "true",
				},
			}),
		).toEqual({ stored: "overage", live: "overage" });
		expect(
			await record({
				providerName: "openrouter",
				accountBillingType: "api",
				responseHeaders: {
					"content-type": "application/json",
					"anthropic-ratelimit-unified-overage-status": "rejected",
				},
			}),
		).toEqual({ stored: "plan", live: "plan" });
	});
});
