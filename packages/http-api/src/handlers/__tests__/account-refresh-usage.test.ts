import { describe, expect, it, mock, spyOn } from "bun:test";
import { usageCache } from "@better-ccflare/providers";
import { registerPollingRestarter } from "@better-ccflare/proxy";
import { createAccountRefreshUsageHandler } from "../accounts";

describe("createAccountRefreshUsageHandler", () => {
	it("allows xAI/Grok accounts to restart usage polling", async () => {
		const accountId = "xai-account";
		const restarter = mock(async (id: string) => id === accountId);
		registerPollingRestarter(`test-xai-refresh-${Date.now()}`, restarter);

		const handler = createAccountRefreshUsageHandler({
			getAccount: async (id: string) =>
				id === accountId
					? {
							id: accountId,
							name: "grok-dogfood",
							provider: "xai",
							access_token: "access-token",
							refresh_token: "refresh-token",
						}
					: null,
		} as never);

		const response = await handler({} as Request, accountId);
		const payload = (await response.json()) as {
			success: boolean;
			pollingRestarted: boolean;
		};

		expect(response.status).toBe(200);
		expect(payload.success).toBe(true);
		expect(payload.pollingRestarted).toBe(true);
		expect(restarter).toHaveBeenCalledWith(accountId);
	});

	for (const [cacheRefreshed, expected, forbidden] of [
		[true, "Usage refreshed for account 'fixture-xai-account'.", null],
		[
			false,
			"the first usage fetch did not finish",
			"Fresh usage data is now available",
		],
	] as const) {
		it(`claims fresh usage only when the restarted poll's fetch finished (cacheRefreshed: ${cacheRefreshed})`, async () => {
			const accountId = `xai-account-${cacheRefreshed}`;
			registerPollingRestarter(
				`test-xai-refresh-message-${cacheRefreshed}-${Date.now()}`,
				async (id: string) => id === accountId,
			);
			const refreshNow = spyOn(usageCache, "refreshNow").mockResolvedValue(
				cacheRefreshed,
			);
			try {
				const handler = createAccountRefreshUsageHandler({
					getAccount: async (id: string) =>
						id === accountId
							? {
									id: accountId,
									name: "fixture-xai-account",
									provider: "xai",
									access_token: "access-token",
									refresh_token: "refresh-token",
								}
							: null,
				} as never);

				const response = await handler({} as Request, accountId);
				const payload = (await response.json()) as {
					success: boolean;
					message: string;
					pollingRestarted: boolean;
					cacheRefreshed: boolean;
				};

				expect(refreshNow).toHaveBeenCalledWith(accountId);
				expect(payload.success).toBe(true);
				expect(payload.pollingRestarted).toBe(true);
				expect(payload.cacheRefreshed).toBe(cacheRefreshed);
				expect(payload.message).toContain(expected);
				if (forbidden) expect(payload.message).not.toContain(forbidden);
			} finally {
				refreshNow.mockRestore();
			}
		});
	}

	it("names Anthropic's refusal when the refreshed usage check was refused (#941)", async () => {
		// Refresh on a refused account used to say the fetch "did not finish",
		// which reads like a network problem, not a billing one.
		const accountId = "anthropic-refused";
		registerPollingRestarter(
			`test-anthropic-refused-${Date.now()}`,
			async (id: string) => id === accountId,
		);
		const refreshNow = spyOn(usageCache, "refreshNow").mockResolvedValue(false);
		const refusedAt = spyOn(usageCache, "getOrgRefusedAt").mockImplementation(
			(id: string) => (id === accountId ? Date.now() - 1_000 : null),
		);
		try {
			const handler = createAccountRefreshUsageHandler({
				getAccount: async (id: string) =>
					id === accountId
						? {
								id: accountId,
								name: "max-refused",
								provider: "anthropic",
								access_token: "access-token",
								refresh_token: "refresh-token",
							}
						: null,
			} as never);

			const payload = (await (
				await handler({} as Request, accountId)
			).json()) as { message: string; cacheRefreshed: boolean };

			expect(payload.cacheRefreshed).toBe(false);
			expect(payload.message).toContain("Anthropic refused");
			expect(payload.message).toContain("max-refused");
			expect(payload.message).toContain("billing");
			expect(payload.message).not.toContain("did not finish");
		} finally {
			refreshNow.mockRestore();
			refusedAt.mockRestore();
		}
	});
});
