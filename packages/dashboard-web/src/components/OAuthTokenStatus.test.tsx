import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OAuthTokenStatusView } from "./OAuthTokenStatus";

it("hides only healthy and loading token views and preserves problem labels", () => {
	const render = (
		status: Parameters<typeof OAuthTokenStatusView>[0]["status"],
	) =>
		renderToStaticMarkup(
			<OAuthTokenStatusView
				status={status}
				message="test message"
				accountName="test-account"
				hasRefreshToken
				provider="anthropic"
			/>,
		);
	expect(render("healthy")).toBe("");
	expect(render("loading")).toBe("");
	for (const status of ["expired", "critical", "warning", "error"] as const) {
		const html = render(status);
		expect(html).toContain("<svg");
		expect(html).toContain('class="sr-only"');
	}
	expect(render("expired")).toContain("OAuth token expired - test message");
	expect(render("warning")).toContain(
		"OAuth token expiring soon - test message",
	);
	expect(render("error")).toContain("Checking OAuth token status");
});

it("renders nothing for accounts without a refresh token", () => {
	for (const status of ["no-refresh-token", "expired", "error"] as const) {
		expect(
			renderToStaticMarkup(
				<OAuthTokenStatusView
					status={status}
					message="test message"
					accountName="api-key-account"
					hasRefreshToken={false}
					provider="openai-compatible"
				/>,
			),
		).toBe("");
	}
});

import { spyOn } from "bun:test";
import * as React from "react";
import { api } from "../api";
import { OAuthTokenStatus } from "./OAuthTokenStatus";

for (const failure of ["throws", "unsuccessful", "missing account"] as const) {
	it(`ends the OAuth fallback at a static unknown icon when global health ${failure}`, async () => {
		const accountHealth = spyOn(api, "getAccountTokenHealth").mockResolvedValue(
			{
				success: false,
				error: "Account health unavailable",
			} as unknown as Awaited<ReturnType<typeof api.getAccountTokenHealth>>,
		);
		const globalHealth = spyOn(api, "getTokenHealth").mockImplementation(
			async () => {
				if (failure === "throws") throw new Error("Global health unavailable");
				return (
					failure === "unsuccessful"
						? { success: false, error: "Global health unavailable" }
						: { success: true, data: { accounts: [] } }
				) as Awaited<ReturnType<typeof api.getTokenHealth>>;
			},
		);
		// Follow RateLimitProgress.lifecycle.test.tsx: execute real hooks/effects,
		// then render the returned view. This does not claim browser mounting.
		const internals = (
			React as unknown as {
				__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE: {
					H: unknown;
				};
			}
		).__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
		const previous = internals.H;
		const states: unknown[] = [];
		const effects: { deps: readonly unknown[]; cleanup?: () => void }[] = [];
		let stateIndex = 0;
		let effectIndex = 0;
		let pending: (() => void)[] = [];
		let dirty = false;
		const dispatcher = {
			useState: (initial: unknown) => {
				const index = stateIndex++;
				if (!(index in states)) states[index] = initial;
				return [
					states[index],
					(value: unknown) => {
						if (!Object.is(states[index], value)) dirty = true;
						states[index] = value;
					},
				];
			},
			useEffect: (
				callback: () => (() => void) | undefined,
				deps: readonly unknown[],
			) => {
				const index = effectIndex++;
				const old = effects[index];
				if (old && deps.every((dep, i) => Object.is(dep, old.deps[i]))) return;
				pending.push(() => {
					old?.cleanup?.();
					effects[index] = { deps, cleanup: callback() };
				});
			},
		};
		let view: ReturnType<typeof OAuthTokenStatus> | undefined;
		try {
			for (let round = 0; round < 10; round++) {
				dirty = false;
				stateIndex = 0;
				effectIndex = 0;
				internals.H = dispatcher;
				view = OAuthTokenStatus({
					accountName: "test-account",
					hasRefreshToken: true,
					provider: "anthropic",
				});
				internals.H = previous;
				for (const effect of pending) effect();
				pending = [];
				await Promise.resolve();
				await Promise.resolve();
				if (!dirty) break;
			}
			expect(globalHealth).toHaveBeenCalledTimes(1);
			const html = renderToStaticMarkup(view);
			expect(html).toContain('title="OAuth token status unknown"');
			expect(html).toContain("<svg");
			expect(html).toContain(
				'class="sr-only">OAuth token status unknown</span>',
			);
			expect(html).not.toContain("animate-spin");
		} finally {
			internals.H = previous;
			for (const effect of effects) effect.cleanup?.();
			accountHealth.mockRestore();
			globalHealth.mockRestore();
		}
	});
}
