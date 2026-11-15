import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Button, touchTargetClass } from "./button";

it("gives touch buttons a 44 px minimum height and default padding", () => {
	const html = renderToStaticMarkup(<Button size="touch">Retry</Button>);
	const classes = html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/);
	for (const name of ["min-h-11", "px-5", "py-2"])
		expect(classes).toContain(name);
});
it("keeps small padding and text on touch-sm buttons", () => {
	const html = renderToStaticMarkup(<Button size="touch-sm">Edit</Button>);
	const classes = html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/);
	for (const name of ["min-h-11", "px-3", "text-xs"])
		expect(classes).toContain(name);
	expect(classes).not.toContain("text-sm");
});
it("gives touch-icon buttons a 44 px square target", () => {
	const html = renderToStaticMarkup(
		<Button size="touch-icon" aria-label="Edit" />,
	);
	const classes = html.match(/class="([^"]*)"/)?.[1]?.split(/\s+/);
	expect(classes).toContain("h-11");
	expect(classes).toContain("w-11");
});
it("exports a touch target class for native controls", () => {
	const html = renderToStaticMarkup(
		<summary className={touchTargetClass}>Details</summary>,
	);
	expect(html).toContain('class="inline-flex min-h-11 items-center"');
});
