import { describe, expect, it } from "bun:test";
import { renderPage } from "../page-state-test-helpers";
import { UsageThrottlingCard } from "./UsageThrottlingCard";

function render(fiveHourEnabled: boolean, weeklyEnabled: boolean) {
	return renderPage(<UsageThrottlingCard />, (client) =>
		client.setQueryData(["usage-throttling"], {
			fiveHourEnabled,
			weeklyEnabled,
		}),
	);
}

const words = (html: string) =>
	[
		...html.matchAll(
			/<span class="text-sm text-muted-foreground">(Enabled|Disabled)<\/span>/g,
		),
	].map((m) => m[1]);

describe("UsageThrottlingCard visible state", () => {
	it("says Enabled or Disabled after each switch, in order", () => {
		expect(words(render(true, false))).toEqual(["Enabled", "Disabled"]);
		expect(words(render(false, true))).toEqual(["Disabled", "Enabled"]);
		expect(words(render(true, true))).toEqual(["Enabled", "Enabled"]);
		expect(words(render(false, false))).toEqual(["Disabled", "Disabled"]);
	});

	it("lets each switch row take the width the word leaves", () => {
		const html = render(true, true);
		expect(html.match(/flex items-center gap-3/g)).toHaveLength(2);
	});
});
