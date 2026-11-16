import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SwitchHitArea, SwitchRow } from "./switch-row";

describe("SwitchRow", () => {
	it("makes the label the switch's 44 px click target", () => {
		const html = renderToStaticMarkup(
			<SwitchRow
				id="retention-store-payloads"
				label="Store message payloads"
			/>,
		);
		expect(html).toMatch(
			/<label[^>]*class="[^"]*inline-flex[^"]*min-h-11[^"]*items-center[^"]*"[^>]*for="retention-store-payloads"[^>]*>Store message payloads<\/label>/,
		);
		expect(html).toContain('role="switch"');
		expect(html).toContain('id="retention-store-payloads"');
	});

	it("ties a description to the switch", () => {
		const html = renderToStaticMarkup(
			<SwitchRow
				id="five-hour"
				label="5-hour window"
				description="Throttle requests when 5-hour usage is ahead of its pacing line."
			/>,
		);
		expect(html).toContain('aria-describedby="five-hour-description"');
		expect(html).toMatch(
			/id="five-hour-description"[^>]*>Throttle requests when 5-hour usage is ahead of its pacing line\./,
		);
	});

	it("has no description reference without a description", () => {
		const html = renderToStaticMarkup(
			<SwitchRow id="routing-capacity" label="Capacity" />,
		);
		expect(html).not.toContain("aria-describedby");
	});

	it("passes checked and disabled through to the switch", () => {
		const html = renderToStaticMarkup(
			<SwitchRow id="flag" label="Flag" checked disabled />,
		);
		expect(html).toContain('aria-checked="true"');
		expect(html).toContain('data-state="checked"');
		expect(html).toMatch(/<button[^>]*disabled=""/);
	});

	it("adds the caller's label classes", () => {
		const html = renderToStaticMarkup(
			<SwitchRow id="flag" label="Flag" labelClassName="font-normal" />,
		);
		expect(html).toMatch(/<label[^>]*class="[^"]*min-h-11[^"]*font-normal/);
	});
});

describe("SwitchHitArea", () => {
	it("wraps an aria-labelled switch in a 44 x 44 label", () => {
		const html = renderToStaticMarkup(
			<SwitchHitArea aria-label="Nightly combo enabled" checked />,
		);
		const label = html.match(/^<label[^>]*>/)?.[0] ?? "";
		const classes = (label.match(/class="([^"]*)"/)?.[1] ?? "").split(" ");
		expect(classes).toContain("h-11");
		expect(classes).toContain("w-11");
		const labelFor = label.match(/for="([^"]+)"/)?.[1];
		const switchTag = html.match(/<button[^>]*role="switch"[^>]*>/)?.[0] ?? "";
		expect(labelFor).toBeDefined();
		expect(switchTag).toContain(`id="${labelFor}"`);
		expect(html).toMatch(/^<label[^>]*><button/);
		expect(switchTag).toContain('aria-label="Nightly combo enabled"');
		expect(switchTag).toContain('aria-checked="true"');
		expect(html.replace(/<[^>]*>/g, "")).toBe("");
	});

	it("keeps a caller's switch id", () => {
		const html = renderToStaticMarkup(
			<SwitchHitArea id="combo-7-enabled" aria-label="Combo enabled" />,
		);
		expect(html).toContain('for="combo-7-enabled"');
		expect(html).toContain('id="combo-7-enabled"');
	});
});
