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
