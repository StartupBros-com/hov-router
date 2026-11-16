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
import {
	QueryClient,
	QueryClientProvider,
	QueryObserver,
} from "@tanstack/react-query";
import { api } from "../api";
import {
	getAccountTokenHealthQueryOptions,
	resolveAccountTokenHealth,
} from "../hooks/queries";
import { queryKeys } from "../lib/query-keys";
import { OAuthTokenStatus } from "./OAuthTokenStatus";

type AccountHealthResponse = Awaited<
	ReturnType<typeof api.getAccountTokenHealth>
>;

const accountHealth = (status: string, message: string) =>
	({
		success: true,
		data: { status, message },
	}) as unknown as AccountHealthResponse;

for (const failure of ["throws", "unsuccessful", "missing account"] as const) {
	it(`ends the OAuth fallback at a static unknown icon when global health ${failure}`, async () => {
		const accountHealthSpy = spyOn(
			api,
			"getAccountTokenHealth",
		).mockResolvedValue({
			success: false,
			error: "Account health unavailable",
		} as unknown as AccountHealthResponse);
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
		try {
			const health = await resolveAccountTokenHealth("test-account");

			expect(globalHealth).toHaveBeenCalledTimes(1);
			expect(health).toEqual({
				status: "unknown",
				message: "OAuth token status unavailable",
			});
			const html = renderToStaticMarkup(
				<OAuthTokenStatusView
					{...health}
					accountName="test-account"
					hasRefreshToken
					provider="anthropic"
				/>,
			);
			expect(html).toContain('title="OAuth token status unknown"');
			expect(html).toContain("<svg");
			expect(html).toContain(
				'class="sr-only">OAuth token status unknown</span>',
			);
			expect(html).not.toContain("animate-spin");
		} finally {
			accountHealthSpy.mockRestore();
			globalHealth.mockRestore();
		}
	});
}

it("re-checks the token mark whenever the accounts data is invalidated (#866)", async () => {
	let current = accountHealth("expired", "Refresh token expired");
	const accountHealthSpy = spyOn(
		api,
		"getAccountTokenHealth",
	).mockImplementation(async () => current);
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false } },
	});
	// A subscribed observer stands in for the mounted row, so invalidation
	// refetches it the way it would on the page.
	const observer = new QueryObserver(
		queryClient,
		getAccountTokenHealthQueryOptions("test-account"),
	);
	const unsubscribe = observer.subscribe(() => {});
	try {
		await queryClient.refetchQueries({
			queryKey: queryKeys.accountTokenHealth("test-account"),
		});
		expect(observer.getCurrentResult().data?.status).toBe("expired");

		// A re-login (or Refresh usage) renews the token, then invalidates the
		// accounts data, as every account mutation does.
		current = accountHealth("healthy", "Token healthy");
		await queryClient.invalidateQueries({ queryKey: queryKeys.accounts() });

		expect(observer.getCurrentResult().data?.status).toBe("healthy");
		expect(accountHealthSpy).toHaveBeenCalledTimes(2);
	} finally {
		unsubscribe();
		queryClient.clear();
		accountHealthSpy.mockRestore();
	}
});

it("renders the token mark from the shared query cache", () => {
	const queryClient = new QueryClient();
	queryClient.setQueryData(queryKeys.accountTokenHealth("test-account"), {
		status: "expired",
		message: "Refresh token expired",
	});
	try {
		const html = renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<OAuthTokenStatus
					accountName="test-account"
					hasRefreshToken
					provider="anthropic"
				/>
			</QueryClientProvider>,
		);
		expect(html).toContain("OAuth token expired - Refresh token expired");
	} finally {
		queryClient.clear();
	}
});
