import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ErrorState } from "./state";

const retryButton = (html: string) =>
	html.match(/<button[^>]*>[^<]*<\/button>/)?.[0] ?? "";

describe("ErrorState retryDisabled", () => {
	for (const size of ["inline", "page"] as const) {
		it(`disables the ${size} Retry and keeps the alert and label`, () => {
			const html = renderToStaticMarkup(
				<ErrorState
					size={size}
					title="Authoritative routing could not load"
					onRetry={() => {}}
					retryLabel="Retry authoritative routing"
					retryDisabled
				/>,
			);
			expect(html).toContain('role="alert"');
			const button = retryButton(html);
			expect(button).toContain(">Retry authoritative routing</button>");
			expect(button).toMatch(/disabled=""/);
		});

		it(`leaves the ${size} Retry enabled by default`, () => {
			const html = renderToStaticMarkup(
				<ErrorState size={size} title="Could not load" onRetry={() => {}} />,
			);
			const button = retryButton(html);
			expect(button).toContain(">Retry</button>");
			expect(button).not.toMatch(/disabled=""/);
		});
	}
});
