import { afterEach, expect, it, mock } from "bun:test";
import { DatabaseOperations } from "@hov-router/database";

const actual = await import("@hov-router/providers/codex");
mock.module("@hov-router/providers/codex", () => ({
	...actual,
	initiateCodexDeviceFlow: async () => ({
		deviceAuthId: "test-device",
		userCode: "TEST",
		verificationUrl: "https://example.invalid/device",
		interval: 1,
	}),
	pollCodexForToken: async () => ({
		access_token: "test-access",
		refresh_token: "test-refresh",
		expires_in: 3600,
	}),
}));
const { createServerDeviceSetupCoordinator } = await import(
	"./server-device-setup"
);
afterEach(() => {
	mock.module("@hov-router/providers/codex", () => actual);
});

it("commits a device-authorized account against the migrated schema", async () => {
	const db = new DatabaseOperations(":memory:", { walMode: false });
	const coordinator = createServerDeviceSetupCoordinator(db);
	try {
		await coordinator.initCodex({
			name: "test-device",
			priority: 0,
			idempotencyKey: "test-device-key",
			reviewed: [],
		});
		await coordinator.drain();
		const accounts = await db.getAllAccounts();
		expect(accounts).toHaveLength(1);
		expect(accounts[0]?.name).toBe("test-device");
		expect(accounts[0]?.model_mappings).toBeNull();
		expect(await db.getAccount(accounts[0]?.id ?? "missing")).toEqual(
			accounts[0],
		);
	} finally {
		coordinator.dispose();
		await db.close();
	}
});
