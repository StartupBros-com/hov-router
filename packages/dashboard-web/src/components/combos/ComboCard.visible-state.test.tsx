import { describe, expect, it } from "bun:test";
import type { Combo } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ComboCard } from "./ComboCard";

function render(enabled: boolean) {
	const combo: Combo = {
		id: "c1",
		name: "Shared route",
		description: null,
		enabled,
		created_at: 1,
		updated_at: 1,
	};
	return renderToStaticMarkup(
		<ComboCard
			combo={combo}
			onEdit={() => {}}
			onDelete={() => {}}
			onToggleEnabled={() => {}}
		/>,
	);
}

const WORD = (word: string) =>
	new RegExp(`<span class="text-sm text-muted-foreground">${word}</span>`);

describe("ComboCard visible state", () => {
	it("says Enabled beside the switch when the combo is enabled", () => {
		const html = render(true);
		expect(html).toMatch(WORD("Enabled"));
		expect(html).not.toMatch(WORD("Disabled"));
	});

	it("says Disabled beside the switch when the combo is disabled", () => {
		const html = render(false);
		expect(html).toMatch(WORD("Disabled"));
		expect(html).not.toMatch(WORD("Enabled"));
	});
});
