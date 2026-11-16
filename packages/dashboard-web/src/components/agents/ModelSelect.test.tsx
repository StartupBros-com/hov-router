import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ModelOptionLabel } from "./ModelSelect";

const LONG = "Agent default — synthetic-sonnet-model";

describe("ModelOptionLabel", () => {
	it("keeps a long default label on one line, with the full text in its title", () => {
		const html = renderToStaticMarkup(
			<ModelOptionLabel label={LONG} badge="Default" isDefault />,
		);
		// The label used to wrap to 3 or 4 rows and spill out of the trigger.
		expect(html).toContain('<span class="flex min-w-0 items-center gap-2">');
		expect(html).toContain(
			`<span class="truncate text-muted-foreground in-data-highlighted:text-current" title="${LONG}">${LONG}</span>`,
		);
	});

	it("keeps the badge whole and opaque so the highlighted row cannot recolour it", () => {
		const html = renderToStaticMarkup(
			<ModelOptionLabel label={LONG} badge="Default" isDefault />,
		);
		const badge = html.match(/<div[^>]*>Default<\/div>/)?.[0] ?? "";
		expect(badge).toContain("shrink-0");
		// An outline badge is transparent: on the orange highlight its text
		// measured 2.44:1.
		expect(badge).toContain("bg-popover");
	});

	it("labels a premium model without muting it", () => {
		const html = renderToStaticMarkup(
			<ModelOptionLabel label="synthetic-opus-model" badge="Premium" />,
		);
		expect(html).toContain(
			'<span class="truncate" title="synthetic-opus-model">synthetic-opus-model</span>',
		);
		const badge = html.match(/<div[^>]*>Premium<\/div>/)?.[0] ?? "";
		expect(badge).toContain("shrink-0");
		expect(html).not.toContain("text-muted-foreground");
	});

	it("renders no badge when none is given", () => {
		const html = renderToStaticMarkup(
			<ModelOptionLabel label="synthetic-haiku-model" />,
		);
		expect(html).not.toContain("<div");
	});
});
