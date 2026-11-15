import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { PageHeader } from "./page-header";

const H1 = '<h1 class="text-2xl font-semibold tracking-tight">';

describe("PageHeader", () => {
	it("renders one plain h1 with the description and the actions slot", () => {
		const html = renderToStaticMarkup(
			<PageHeader
				title="Agents"
				description="Discover and manage Claude Code agents"
				actions={<button type="button">Act</button>}
			/>,
		);
		expect(html.match(/<h1\b/g)).toHaveLength(1);
		expect(html).toContain(`${H1}Agents</h1>`);
		expect(html).not.toContain("<h2");
		expect(html).not.toContain(["gradient", "text"].join("-"));
		expect(html).toBe(
			'<div class="flex flex-wrap items-center justify-between gap-4"><div>' +
				`${H1}Agents</h1>` +
				'<p class="text-sm text-muted-foreground">Discover and manage Claude Code agents</p>' +
				'</div><div class="flex min-w-0 flex-wrap items-center gap-3"><button type="button">Act</button></div></div>',
		);
	});

	it("leaves out the description and actions when none are given", () => {
		expect(renderToStaticMarkup(<PageHeader title="Logs" />)).toBe(
			`<div class="flex flex-wrap items-center justify-between gap-4"><div>${H1}Logs</h1></div></div>`,
		);
	});
});
