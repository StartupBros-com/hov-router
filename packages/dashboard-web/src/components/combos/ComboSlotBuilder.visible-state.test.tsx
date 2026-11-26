import { describe, expect, it, mock } from "bun:test";
import type { ComboWithSlots } from "@hov-router/types";
import type { ReactNode } from "react";
import { queryKeys } from "../../lib/query-keys";

// The add form opens from a click on local state, which a static render
// cannot reach. Answer the component's first two useState calls (its
// showAddForm flag, then the chosen account id) with the values under test.
const flags = { open: false, accountId: "", calls: 0 };
const React = require("react") as { useState: (initial: unknown) => unknown };
const realUseState = React.useState;
React.useState = (initial: unknown) => {
	flags.calls += 1;
	if (flags.open && flags.calls === 1) return [true, () => {}];
	if (flags.open && flags.calls === 2) return [flags.accountId, () => {}];
	return realUseState(initial);
};

// Record the props the list hands to DndContext, then draw its children as usual.
const dnd = await import("@dnd-kit/core");
const dndProps: { sensors?: Array<{ sensor: unknown }> } = {};
mock.module("@dnd-kit/core", () => ({
	...dnd,
	DndContext: (props: {
		sensors?: Array<{ sensor: unknown }>;
		children?: ReactNode;
	}) => {
		dndProps.sensors = props.sensors;
		return <>{props.children}</>;
	},
}));

const { renderPage } = await import("../page-state-test-helpers");
const { ComboSlotBuilder } = await import("./ComboSlotBuilder");

const combo: ComboWithSlots = {
	id: "combo-1",
	name: "Route",
	description: null,
	enabled: true,
	created_at: 1,
	updated_at: 1,
	slots: [],
};
const accounts = [
	{ id: "acct-codex", name: "codex-one", provider: "codex" },
	{ id: "acct-anthropic", name: "claude-one", provider: "anthropic" },
];
const REASON =
	"A model is required for codex: this provider does not serve Claude model ids, so there is no passthrough.";

function render(open: boolean, accountId = "") {
	flags.open = open;
	flags.accountId = accountId;
	flags.calls = 0;
	return renderPage(<ComboSlotBuilder combo={combo} />, (client) =>
		client.setQueryData(queryKeys.accounts(), accounts),
	).replace(/&#x27;/g, "'");
}

describe("ComboSlotBuilder visible state", () => {
	it("labels the add-slot account and model fields by id", () => {
		const html = render(true);
		for (const id of ["new-combo-slot-account", "new-combo-slot-model"]) {
			expect(html).toContain(`for="${id}"`);
			expect(html).toContain(`id="${id}"`);
		}
	});

	it("lets the member list be reordered from the keyboard", () => {
		dndProps.sensors = undefined;
		renderPage(
			<ComboSlotBuilder
				combo={{
					...combo,
					slots: [
						{
							id: "s1",
							combo_id: "combo-1",
							account_id: "acct-codex",
							model: "m",
							priority: 0,
							enabled: true,
						},
					],
				}}
			/>,
			(client) => client.setQueryData(queryKeys.accounts(), accounts),
		);
		const captured = dndProps.sensors as Array<{ sensor: unknown }> | undefined;
		const sensors = (captured ?? []).map((entry) => entry.sensor);
		expect(sensors).toContain(dnd.KeyboardSensor);
		expect(sensors).toContain(dnd.PointerSensor);
	});

	it("shows no add form and no reason while the form is closed", () => {
		const html = render(false);
		expect(html).not.toContain("Priority tier");
		expect(html).not.toContain("does not serve Claude model ids");
	});

	it("names no provider before an account is chosen", () => {
		const html = render(true);
		expect(html).toContain("Priority tier");
		expect(html).not.toContain("A model is required");
		expect(html).not.toContain("for null");
	});

	it("shows the required-model reason as text exactly when the title carries it", () => {
		const html = render(true, "acct-codex");
		expect(html).toContain(`title="${REASON}"`);
		expect(html).toContain(
			`<p class="text-xs text-muted-foreground">${REASON}</p>`,
		);
		expect(html.indexOf(`>${REASON}</p>`)).toBeLessThan(
			html.indexOf(">Cancel<"),
		);
	});

	it("shows no reason for a provider that passes Claude model ids through", () => {
		const html = render(true, "acct-anthropic");
		expect(html).toContain("Priority tier");
		expect(html).not.toContain("A model is required");
	});
});
