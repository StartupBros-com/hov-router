import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Notice } from "./notice";

describe("Notice", () => {
	it("draws a warning from the warning tokens without announcing it", () => {
		const html = renderToStaticMarkup(
			<Notice tone="warning">Admin keys can manage accounts.</Notice>,
		);
		expect(html).toContain('data-tone="warning"');
		expect(html).toContain("border-(--warning)/30");
		expect(html).toContain("bg-(--warning-soft)");
		expect(html).toContain("text-(--warning)");
		expect(html).not.toContain('role="alert"');
		expect(html).toContain("Admin keys can manage accounts.");
	});

	it("announces a danger notice as an alert", () => {
		const html = renderToStaticMarkup(
			<Notice tone="danger">Failed to generate API key.</Notice>,
		);
		expect(html).toContain('role="alert"');
		expect(html).toContain('data-tone="danger"');
		expect(html).toContain("text-destructive");
	});

	it("draws info from the info tokens", () => {
		const html = renderToStaticMarkup(<Notice tone="info">Note.</Notice>);
		expect(html).toContain("bg-(--info-soft)");
		expect(html).toContain("text-(--info)");
		expect(html).not.toContain('role="alert"');
	});

	it("hides its icon from assistive technology", () => {
		const html = renderToStaticMarkup(<Notice tone="warning">Text</Notice>);
		expect(html).toMatch(/<svg[^>]*aria-hidden="true"/);
	});

	it("renders a title and an action beside the text", () => {
		const html = renderToStaticMarkup(
			<Notice
				tone="danger"
				title="Important:"
				action={<button type="button">Dismiss</button>}
			>
				Save this key.
			</Notice>,
		);
		const text = html.replace(/<[^>]*>/g, "");
		expect(text).toBe("Important:Save this key.Dismiss");
	});

	it("never uses a raw palette class", () => {
		for (const tone of ["warning", "danger", "info"] as const) {
			const html = renderToStaticMarkup(<Notice tone={tone}>x</Notice>);
			expect(html).not.toMatch(
				/(?:^|[\s"])(?:dark:)?(?:bg|text|border)-(?:yellow|amber|red|green|blue|gray)-\d/,
			);
		}
	});
});
