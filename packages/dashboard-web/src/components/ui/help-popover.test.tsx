import { expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { HelpPopover } from "./help-popover";

it("gives the trigger a 44 x 44 box that takes today's 20 px of layout", () => {
	const html = renderToStaticMarkup(
		<HelpPopover label="How a combo decides which account and model to use">
			Explanation
		</HelpPopover>,
	);
	const trigger = html.match(/<button[^>]*>/)?.[0] ?? "";
	expect(trigger).toContain(
		'aria-label="How a combo decides which account and model to use"',
	);
	const classes = (trigger.match(/class="([^"]*)"/)?.[1] ?? "").split(" ");
	expect(classes).toContain("h-11");
	expect(classes).toContain("w-11");
	// 44 px minus 12 px of negative margin on each side leaves 20 px of layout.
	expect(classes).toContain("-m-3");
	expect(classes).not.toContain("h-5");
	expect(classes).not.toContain("w-5");
});
