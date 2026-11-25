/**
 * With the extra-usage switch on, a response Anthropic reports as billed to
 * extra usage holds the login: the recorder sends the guarded billed-hold
 * write straight to the database, not through the write queue, with the
 * billed time and the model family. The request is still labelled
 * `overage` whatever the switch says.
 *
 * The database's hold write is stubbed, so this covers the recorder's
 * decision and the call; the SQL guard itself is covered in
 * packages/database/src/repositories/__tests__/account-extra-usage-holds.test.ts.
 */
import {
	afterAll,
	afterEach,
	beforeAll,
	describe,
	expect,
	it,
	mock,
	spyOn,
} from "bun:test";
import "@better-ccflare/core";
import { AsyncDbWriter, DatabaseOperations } from "@better-ccflare/database";
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

const ACCOUNT_ID = "acct-claude";
const REPLY = Buffer.from(
	JSON.stringify({
		id: "msg_1",
		type: "message",
		role: "assistant",
		model: "claude-opus-5-5",
		content: [{ type: "text", text: "ok" }],
		usage: { input_tokens: 3, output_tokens: 2 },
	}),
).toString("base64");
/** The header Anthropic sends on a response billed to extra usage. */
const BILLED = { "anthropic-ratelimit-unified-overage-in-use": "true" };

let db: DatabaseOperations;
let writer: AsyncDbWriter;
let collector: InstanceType<typeof UsageCollector>;
let holdCalls: Array<[string, number, string | null]>;
let holdSpy: ReturnType<typeof spyOn>;
let nextRequest = 0;

beforeAll(async () => {
	const ambientUrl = process.env.DATABASE_URL;
	try {
		delete process.env.DATABASE_URL;
		db = new DatabaseOperations(":memory:", { cacheSize: -2048 });
	} finally {
		if (ambientUrl === undefined) delete process.env.DATABASE_URL;
		else process.env.DATABASE_URL = ambientUrl;
	}
	await db
		.getAdapter()
		.run(
			"INSERT INTO accounts (id, name, provider, created_at, auto_pause_on_overage_enabled) VALUES (?, 'claude', 'anthropic', 1, 1)",
			[ACCOUNT_ID],
		);
	writer = new AsyncDbWriter();
	collector = new UsageCollector(
		db,
		writer,
		() => false,
		() => {},
	);
	holdCalls = [];
	holdSpy = spyOn(db, "holdForBilledResponse").mockImplementation(
		async (accountId: string, billedAt: number, family: string | null) => {
			holdCalls.push([accountId, billedAt, family]);
			return true;
		},
	);
});

afterEach(() => {
	holdCalls.length = 0;
});

afterAll(async () => {
	holdSpy.mockRestore();
	collector.dispose();
	await writer.dispose();
	await db.close();
});

/** Record one successful non-streaming reply; returns its stored billing label. */
async function record(
	overrides: Partial<StartMessage>,
	{ readLabel = true }: { readLabel?: boolean } = {},
): Promise<string | null> {
	nextRequest += 1;
	const requestId = `request-${nextRequest}`;
	collector.handleStart({
		type: "start",
		messageId: `message-${nextRequest}`,
		requestId,
		accountId: ACCOUNT_ID,
		method: "POST",
		path: "/v1/messages",
		timestamp: Date.now(),
		requestHeaders: {},
		requestBody: null,
		project: null,
		responseStatus: 200,
		responseHeaders: { "content-type": "application/json", ...BILLED },
		isStream: false,
		accountBillingType: null,
		accountAutoPauseOnOverageEnabled: 1,
		accountName: "claude",
		agentUsed: null,
		comboName: null,
		apiKeyId: null,
		apiKeyName: null,
		retryAttempt: 0,
		failoverAttempts: 0,
		providerName: "anthropic",
		accounting: {
			accountGeneration: 1,
			provider: "anthropic",
			model: "claude-opus-5-5",
			nativeCache: true,
			internal: false,
		},
		...overrides,
	});
	await collector.handleEnd({
		type: "end",
		requestId,
		success: true,
		responseBody: REPLY,
	});
	await collector.drain();
	if (!readLabel) return null;
	const row = await db
		.getAdapter()
		.getMain<{ billing_type: string | null }>(
			"SELECT billing_type FROM requests WHERE id = ?",
			[requestId],
		);
	expect(row).not.toBeNull();
	return row?.billing_type ?? null;
}

describe("a billed response holds the login", () => {
	it("with the switch on, an Opus response billed to extra usage writes the billed hold with family opus", async () => {
		const before = Date.now();
		const label = await record({});
		const after = Date.now();
		expect(label).toBe("overage");
		expect(holdCalls).toHaveLength(1);
		const [accountId, billedAt, family] = holdCalls[0] ?? [];
		expect(accountId).toBe(ACCOUNT_ID);
		expect(family).toBe("opus");
		expect(billedAt).toBeGreaterThanOrEqual(before);
		expect(billedAt).toBeLessThanOrEqual(after);
	});

	it("with the switch off, no hold is written and the request is still labelled overage", async () => {
		const label = await record({ accountAutoPauseOnOverageEnabled: 0 });
		expect(label).toBe("overage");
		expect(holdCalls).toEqual([]);
	});

	it("a response not billed to extra usage writes no hold", async () => {
		const label = await record({
			responseHeaders: { "content-type": "application/json" },
		});
		expect(label).toBe("plan");
		expect(holdCalls).toEqual([]);
	});

	it("with the write queue full, the billed hold is still written", async () => {
		const full = spyOn(writer, "enqueue").mockImplementation(() => false);
		try {
			await record({}, { readLabel: false });
		} finally {
			full.mockRestore();
		}
		expect(holdCalls.map(([id, , family]) => [id, family])).toEqual([
			[ACCOUNT_ID, "opus"],
		]);
	});

	it("a Sonnet response billed to extra usage writes the billed hold with family sonnet", async () => {
		await record({
			accounting: {
				accountGeneration: 1,
				provider: "anthropic",
				model: "claude-sonnet-5-5",
				nativeCache: true,
				internal: false,
			},
		});
		expect(holdCalls.map(([, , family]) => family)).toEqual(["sonnet"]);
	});

	it("with no model on the start message, the billed family is null", async () => {
		await record({
			accounting: {
				accountGeneration: 1,
				provider: "anthropic",
				model: null,
				nativeCache: true,
				internal: false,
			},
		});
		expect(holdCalls.map(([, , family]) => family)).toEqual([null]);
	});

	it("a billed response after the member resumed the login writes the billed hold again", async () => {
		await record({});
		// The member resumes the login between the two responses; the recorder
		// keeps no memory of the earlier hold, so the next billed response
		// reaches the guarded write again.
		await db.resumeAccount(ACCOUNT_ID);
		await record({});
		expect(holdCalls).toHaveLength(2);
	});
});
