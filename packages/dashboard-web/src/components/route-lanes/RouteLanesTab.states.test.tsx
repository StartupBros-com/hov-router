import { describe, expect, it } from "bun:test";
import { HttpError } from "@better-ccflare/http-common";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import type { RouteLanes } from "../../lib/route-lanes-api";
import {
	expectHeader,
	renderPage,
	seedState,
	type TestState,
} from "../page-state-test-helpers";
import { laneFormMissing, RouteLaneForm } from "./RouteLaneDialog";
import {
	RouteLanesTab,
	routeLanesSourceText,
	saveErrorText,
} from "./RouteLanesTab";

const lanes: RouteLanes = {
	revision: 4,
	profiles: [
		{
			id: "cvp-opus",
			displayName: "CVP Opus",
			accountId: "acct-1",
			logicalModel: "opus",
			exclusiveAccount: true,
		},
		{
			id: "spare",
			displayName: "Spare",
			accountId: "acct-gone",
			logicalModel: "sonnet",
		},
	],
	lanes: [
		{
			id: "cvp-opus",
			displayName: "CVP Opus",
			modelIds: ["claude-bccf-route-cvp-opus"],
			accountId: "acct-1",
			accountName: "max-primary",
			logicalModel: "claude-opus-5-5",
			exclusiveAccount: true,
		},
		{
			id: "spare",
			displayName: "Spare",
			modelIds: ["claude-bccf-route-spare"],
			accountId: "acct-gone",
			logicalModel: "claude-sonnet-5-5",
			exclusiveAccount: false,
		},
	],
	status: {
		source: "database",
		status: "ok",
		count: 2,
		revision: 4,
		ignored: "file",
	},
	warnings: ["lane spare: account acct-gone matches no account"],
};

function render(state: TestState, data: RouteLanes = lanes) {
	return renderPage(<RouteLanesTab />, (client) =>
		seedState(client, queryKeys.routeLanes(), state, data),
	);
}

describe("Route lanes states", () => {
	it("shows a loading state under one header", () => {
		const html = render("loading");
		expectHeader(html, "routeLanes");
		expect(html).toContain("Loading route lanes");
		expect(html).not.toContain("Add lane");
	});

	it("shows an error with retry when nothing has loaded", () => {
		const html = render("error");
		expectHeader(html, "routeLanes");
		expect(html).toContain("Route lanes could not load");
		expect(html).toContain("Network error");
		expect(html).toContain("Retry");
	});

	it("lists each lane with its picker id, account and resolved model", () => {
		const html = render("empty");
		expectHeader(html, "routeLanes");
		expect(html).toContain("CVP Opus");
		expect(html).toContain("claude-bccf-route-cvp-opus");
		expect(html).toContain("max-primary");
		expect(html).toContain("claude-opus-5-5");
		expect(html).toContain("Exclusive account");
		// An account the router does not know is shown by id, with the warning.
		expect(html).toContain("acct-gone");
		expect(html).toContain("lane spare: account acct-gone matches no account");
		expect(html).toContain("Stored in the router&#x27;s database, revision 4");
		expect(html).toContain("profiles file is still set but no longer read");
		expect(html).toContain('aria-label="Edit CVP Opus"');
		expect(html).toContain('aria-label="Delete Spare"');
		expect(html).toContain("Edit as JSON");
	});

	it("keeps the cached lanes after a failed refresh", () => {
		const html = render("cached");
		expect(html).toContain("CVP Opus");
		expect(html).toContain("Showing the last lanes loaded");
	});

	it("offers to add the first lane when there are none", () => {
		const html = render("empty", {
			...lanes,
			revision: 0,
			profiles: [],
			lanes: [],
			warnings: [],
			status: { source: "none", status: "ok", count: 0 },
		});
		expect(html).toContain("No route lanes");
		expect(html).toContain("No lanes yet. The first save stores them");
	});
});

describe("route lanes text", () => {
	it("names where the lanes came from", () => {
		expect(
			routeLanesSourceText({ source: "file", status: "ok", count: 6 }),
		).toBe(
			"Loaded from the profiles file. The first save stores them in the database.",
		);
	});

	it("explains a stale save and passes other errors through", () => {
		const format = (error: unknown) =>
			error instanceof Error ? error.message : "?";
		expect(
			saveErrorText(
				new HttpError(409, "Route lanes changed since revision 4"),
				format,
			),
		).toContain("The lanes changed after this dialog opened");
		expect(
			saveErrorText(
				new HttpError(400, "profile 0 contains unknown field nope"),
				format,
			),
		).toBe("profile 0 contains unknown field nope");
	});
});

describe("RouteLaneForm", () => {
	const save = {
		isPending: false,
		mutate: () => {},
	} as unknown as Parameters<typeof RouteLaneForm>[0]["save"];
	const accounts = [
		{ id: "acct-1", name: "max-primary", provider: "anthropic" },
	];

	it("needs an id, a name, an account and a model before it can save", () => {
		expect(
			laneFormMissing({
				id: " ",
				displayName: "",
				accountId: "",
				logicalModel: "",
				description: "",
				exclusiveAccount: false,
			}),
		).toEqual(["id", "display name", "account", "model"]);
	});

	it("fills the form from the lane being edited and shows the server's message", () => {
		const html = renderToStaticMarkup(
			<RouteLaneForm
				base={lanes}
				originalId="cvp-opus"
				accounts={accounts}
				save={save}
				errorText="profile 0 contains unknown field nope"
				stale={false}
				onClose={() => {}}
			/>,
		);
		expect(html).toContain('value="cvp-opus"');
		expect(html).toContain('value="CVP Opus"');
		expect(html).toContain('value="opus"');
		expect(html).toContain("profile 0 contains unknown field nope");
	});

	it("sends a capability lane to the JSON view instead of the form", () => {
		const html = renderToStaticMarkup(
			<RouteLaneForm
				base={{
					...lanes,
					profiles: [
						{
							id: "pool",
							displayName: "Pool",
							selection: "capability",
							logicalModel: "opus",
						},
					],
				}}
				originalId="pool"
				accounts={accounts}
				save={save}
				errorText={null}
				stale={false}
				onClose={() => {}}
			/>,
		);
		expect(html).toContain("Edit it with Edit as JSON.");
		expect(html).not.toContain('id="lane-id"');
	});

	it("blocks a second save once one was refused as stale", () => {
		const render = (stale: boolean) =>
			renderToStaticMarkup(
				<RouteLaneForm
					base={lanes}
					originalId="cvp-opus"
					accounts={accounts}
					save={save}
					errorText={null}
					stale={stale}
					onClose={() => {}}
				/>,
			);
		const submitButton = (html: string) =>
			html.slice(
				html.indexOf('type="submit"') - 200,
				html.indexOf("Save lane"),
			);
		expect(submitButton(render(false))).not.toContain("disabled");
		expect(submitButton(render(true))).toContain("disabled");
	});
});
