import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { StatusPill } from "./status-pill";

for (const tone of [
	"neutral",
	"success",
	"warning",
	"danger",
	"info",
	"secondary",
	"primary",
] as const) {
	it(`renders the ${tone} tone on the pill`, () => {
		const html = renderToStaticMarkup(
			<StatusPill tone={tone}>Status</StatusPill>,
		);
		expect(html).toMatch(new RegExp(`<span[^>]*data-tone="${tone}"`));
	});
}
it("retains both the small font size and warning text colour", () => {
	const html = renderToStaticMarkup(
		<StatusPill tone="warning">Last known</StatusPill>,
	);
	const classes = html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/);
	expect(classes).toContain("text-xs");
	expect(classes).toContain("text-(--warning)");
});
it("merges a caller className with the base classes", () => {
	const html = renderToStaticMarkup(
		<StatusPill className="px-4 mt-2">Status</StatusPill>,
	);
	const classes = html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/);
	expect(classes).toContain("inline-flex");
	expect(classes).toContain("mt-2");
	expect(classes).toContain("px-4");
	expect(classes).not.toContain("px-2");
});
