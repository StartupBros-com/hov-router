import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { CopyButton, CopyButtonFace } from "./CopyButton";

// Markup of the call sites: the two API Keys ones at their 44 px size (#850), the nav one unchanged since 772a576d.
const API_KEYS_ROW =
	'<button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 border-2 border-border bg-background shadow-sm hover:bg-accent hover:text-accent-foreground hover:border-primary/50 h-11 w-11 relative overflow-hidden" title="Copy key ending abcd1234" aria-label="Copy key ending abcd1234"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy h-4 w-4" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg></button><span role="status" class="sr-only"></span>';
const API_KEYS_NEW_KEY =
	'<button class="inline-flex items-center justify-center gap-2 whitespace-nowrap rounded-md text-sm font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 border-2 border-border bg-background shadow-sm hover:bg-accent hover:text-accent-foreground hover:border-primary/50 h-11 w-11 relative overflow-hidden" aria-label="Copy API key"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy h-4 w-4" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg></button><span role="status" class="sr-only"></span>';
const NAV_UPDATE_COMMAND =
	'<button class="inline-flex items-center justify-center gap-2 whitespace-nowrap font-medium transition-all duration-200 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&amp;_svg]:pointer-events-none [&amp;_svg]:size-4 [&amp;_svg]:shrink-0 hover:bg-accent hover:text-accent-foreground rounded-md text-xs relative overflow-hidden h-6 w-6 p-0" title="Copy update command"><svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" class="lucide lucide-copy h-4 w-4" aria-hidden="true"><rect width="14" height="14" x="8" y="8" rx="2" ry="2"></rect><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"></path></svg></button>';

describe("CopyButton", () => {
	it("renders the API Keys and nav call sites exactly as before", () => {
		expect(
			renderToStaticMarkup(
				<CopyButton
					variant="outline"
					size="touch-icon"
					value="abcd1234"
					title="Copy key ending abcd1234"
					label="Copy key ending abcd1234"
				/>,
			),
		).toBe(API_KEYS_ROW);
		expect(
			renderToStaticMarkup(
				<CopyButton
					variant="outline"
					size="touch-icon"
					value="sk-test"
					label="Copy API key"
				/>,
			),
		).toBe(API_KEYS_NEW_KEY);
		expect(
			renderToStaticMarkup(
				<CopyButton
					value="bun update"
					size="sm"
					variant="ghost"
					className="h-6 w-6 p-0"
					title="Copy update command"
				/>,
			),
		).toBe(NAV_UPDATE_COMMAND);
	});

	it("keeps its ghost, small default when no variant or size is passed", () => {
		// No call site relies on the defaults today, so the call-site pins above cannot catch a changed default.
		expect(renderToStaticMarkup(<CopyButton value="x" />)).toBe(
			renderToStaticMarkup(<CopyButton value="x" variant="ghost" size="sm" />),
		);
	});

	it("names a labelled button and announces the copy outside it", () => {
		const html = renderToStaticMarkup(
			<CopyButton
				size="touch-icon"
				title="Copy as JSON"
				label="Copy request as JSON"
				value="x"
			/>,
		);
		expect(html).toContain('aria-label="Copy request as JSON"');
		expect(
			html.endsWith('</button><span role="status" class="sr-only"></span>'),
		).toBe(true);
	});
});

describe("CopyButtonFace", () => {
	it("keeps a labelled button's text when the copy succeeds or fails", () => {
		const copied = renderToStaticMarkup(
			<CopyButtonFace state="copied">Copy request</CopyButtonFace>,
		);
		expect(copied).toContain("lucide-check");
		expect(copied).toContain("Copied");
		expect(copied).not.toContain("Copy request");
		const failed = renderToStaticMarkup(
			<CopyButtonFace state="errored">Copy request</CopyButtonFace>,
		);
		expect(failed).toContain("Copy failed");
	});

	it("keeps an icon-only button icon-only", () => {
		const copied = renderToStaticMarkup(<CopyButtonFace state="copied" />);
		expect(copied).toContain("lucide-check");
		expect(copied).not.toContain("Copied");
	});
});
