import { describe, expect, it } from "bun:test";
import type {
	Combo,
	ComboFamily,
	ComboFamilyAssignment,
	ComboRoutingPreviewResult,
	ComboSlot,
	ComboWithSlots,
	EffectiveComboRoutingView,
} from "@better-ccflare/types";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../../lib/query-keys";
import { ComboCard, type ComboFamilyRoutingCardState } from "./ComboCard";
import { ComboSlotBuilder } from "./ComboSlotBuilder";
import { FamilyActivationSection } from "./FamilyActivationSection";
import {
	ManagedFamilyConversionBody,
	ManagedFamilyConversionReview,
} from "./ManagedFamilyConversionDialog";

const combo: Combo = {
	id: "combo-shared",
	name: "Shared priority route",
	description: "Routes more than one model family",
	enabled: true,
	created_at: 1,
	updated_at: 1,
};

function assignment(
	family: ComboFamily,
	membershipMode: "manual" | "managed",
	enabled = true,
): ComboFamilyAssignment {
	return {
		family,
		combo_id: combo.id,
		enabled,
		membership_mode: membershipMode,
		managed_model:
			membershipMode === "managed" ? `claude-${family}-managed` : null,
	};
}

function cardState(
	family: ComboFamily,
	membershipMode: "manual" | "managed",
	enabled = true,
): ComboFamilyRoutingCardState {
	return {
		assignment: assignment(family, membershipMode, enabled),
		routing: null,
	};
}

/** The data-tone of the pill whose text is exactly `text`. */
function toneOf(html: string, text: string): string | null {
	const end = html.indexOf(`>${text}</span>`);
	if (end === -1) return null;
	const marker = '<span data-tone="';
	const start = html.lastIndexOf(marker, end);
	if (start === -1) return null;
	const valueStart = start + marker.length;
	return html.slice(valueStart, html.indexOf('"', valueStart));
}

/** The whole opening tag that contains `needle`. */
function tagAround(html: string, needle: string): string {
	const at = html.indexOf(needle);
	if (at === -1) return "";
	const start = html.lastIndexOf("<", at);
	return html.slice(start, html.indexOf(">", at) + 1);
}

function renderCard(routings: ComboFamilyRoutingCardState[]) {
	return renderToStaticMarkup(
		<ComboCard
			combo={combo}
			slotCount={2}
			familyRoutings={routings}
			onEdit={() => undefined}
			onDelete={() => undefined}
			onToggleEnabled={() => undefined}
		/>,
	);
}

function effectiveView(): EffectiveComboRoutingView {
	return {
		family: "opus",
		policy: {
			assignment: assignment("opus", "managed"),
			combo,
			slots: [],
			rules: [],
			exclusions: [],
		},
		resolution: {
			family: "opus",
			combo_id: combo.id,
			active: true,
			reason: null,
			members: [],
			decisions: [],
		},
	};
}

const manualSlot: ComboSlot = {
	id: "slot-one",
	combo_id: combo.id,
	account_id: "account-one",
	model: "model-one",
	priority: 1,
	enabled: true,
};

const comboWithSlots: ComboWithSlots = { ...combo, slots: [manualSlot] };

function builderClient(): QueryClient {
	return new QueryClient({
		defaultOptions: {
			queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
		},
	});
}

function renderBuilder(client: QueryClient) {
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<ComboSlotBuilder combo={comboWithSlots} />
			</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}

function seedBuilder(client: QueryClient) {
	client.setQueryData(queryKeys.accounts(), [
		{ id: "account-one", name: "Account one", provider: "anthropic" },
	]);
	client.setQueryData(queryKeys.families(), {
		families: [assignment("opus", "managed"), assignment("fable", "manual")],
	});
}

function failEffectiveRouting(
	client: QueryClient,
	fetchStatus: "idle" | "fetching",
) {
	const key = queryKeys.routingEffective();
	client.setQueryData(key, []);
	client
		.getQueryCache()
		.find({ queryKey: key })
		?.setState({
			status: "error",
			fetchStatus,
			error: new Error("controlled effective-routing failure"),
		});
}

describe("Combos pill tones", () => {
	it("tones the mode pills Managed primary and Manual neutral on the card", () => {
		const html = renderCard([
			cardState("opus", "managed"),
			cardState("fable", "manual"),
		]);
		expect(toneOf(html, "Managed mode")).toBe("primary");
		expect(toneOf(html, "Manual mode")).toBe("neutral");
	});

	it("tones an inactive family assignment neutral and shows no Active text on the card", () => {
		const html = renderCard([cardState("opus", "manual", false)]);
		expect(toneOf(html, "Inactive")).toBe("neutral");
		expect(html).not.toContain(">Active<");
	});

	it("tones the assigned-family pills in the slot builder by mode", () => {
		const client = builderClient();
		seedBuilder(client);
		client.setQueryData(queryKeys.routingEffective(), []);
		const html = renderBuilder(client);
		expect(toneOf(html, "opus · managed")).toBe("primary");
		expect(toneOf(html, "fable · manual")).toBe("neutral");
	});

	it("tones the Active status of an enabled family with a combo success", () => {
		const client = builderClient();
		client.setQueryData(queryKeys.combos(), { combos: [combo] });
		client.setQueryData(queryKeys.families(), {
			families: [assignment("opus", "manual")],
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<FamilyActivationSection />
			</QueryClientProvider>,
		);
		expect(toneOf(html, "Active")).toBe("success");
	});

	it("tones high confidence success and low confidence warning", () => {
		const proposalFor = (highConfidence: boolean) =>
			({
				proposal_id: `p-${highConfidence}`,
				family: "opus",
				combo_id: combo.id,
				provider: "anthropic",
				route_class: "oauth-subscription",
				existing_rule_id: null,
				managed_model: "claude-opus-4-8",
				policy_managed_model: "claude-opus-4-8",
				tier_source: "account_priority",
				high_confidence: highConfidence,
				selected_by_default: false,
				reason: "included",
				proposed_effective: effectiveView(),
				member_delta: [],
			}) as unknown as ComboRoutingPreviewResult["proposals"][number];
		const html = renderToStaticMarkup(
			<ManagedFamilyConversionReview
				family="opus"
				managedModel="claude-opus-4-8"
				preview={
					{
						preview_id: "preview",
						scope: "family",
						family: "opus",
						managed_model: "claude-opus-4-8",
						policy_managed_model: "claude-opus-4-8",
						proposals: [proposalFor(true), proposalFor(false)],
						effective: effectiveView(),
					} as ComboRoutingPreviewResult
				}
				selectedProposalId={null}
				reviewAcknowledged={false}
				onProposalSelect={() => undefined}
				onReviewAcknowledgedChange={() => undefined}
			/>,
		);
		expect(toneOf(html, "High confidence")).toBe("success");
		expect(toneOf(html, "Low confidence")).toBe("warning");
	});
});

describe("ComboSlotBuilder section error", () => {
	it("labels Retry, keeps role=alert and enables it while idle", () => {
		const client = builderClient();
		seedBuilder(client);
		failEffectiveRouting(client, "idle");
		const html = renderBuilder(client);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Authoritative routing could not be refreshed");
		const buttonStart = html.lastIndexOf(
			"<button",
			html.indexOf("Retry authoritative routing</button>"),
		);
		expect(buttonStart).toBeGreaterThan(-1);
		const openTag = html.slice(buttonStart, html.indexOf(">", buttonStart) + 1);
		expect(openTag).not.toContain('disabled=""');
	});

	it("disables Retry while the query is fetching", () => {
		const client = builderClient();
		seedBuilder(client);
		failEffectiveRouting(client, "fetching");
		const html = renderBuilder(client);
		expect(html).toContain('role="alert"');
		const buttonStart = html.lastIndexOf(
			"<button",
			html.indexOf("Retry authoritative routing</button>"),
		);
		expect(buttonStart).toBeGreaterThan(-1);
		const openTag = html.slice(buttonStart, html.indexOf(">", buttonStart) + 1);
		expect(openTag).toContain('disabled=""');
	});
});

describe("ManagedFamilyConversionBody preview error", () => {
	function renderBody(isPreviewLoading: boolean) {
		return renderToStaticMarkup(
			<ManagedFamilyConversionBody
				family="opus"
				managedModel="claude-opus-4-8"
				preview={null}
				selectedProposalId={null}
				reviewAcknowledged={false}
				isPreviewLoading={isPreviewLoading}
				previewError={new Error("preview failed")}
				isApplying={false}
				applyError={null}
				onProposalSelect={() => undefined}
				onReviewAcknowledgedChange={() => undefined}
				onRetry={() => undefined}
			/>,
		);
	}
	function retryOpenTag(html: string): string {
		const end = html.indexOf("Refresh preview</button>");
		if (end === -1) return "";
		const start = html.lastIndexOf("<button", end);
		return html.slice(start, html.indexOf(">", start) + 1);
	}

	it("offers an enabled Refresh preview button inside role=alert", () => {
		const html = renderBody(false);
		expect(html).toContain('role="alert"');
		expect(html).toContain("preview failed");
		const tag = retryOpenTag(html);
		expect(tag).not.toBe("");
		expect(tag).not.toContain('disabled=""');
		expect(html.indexOf('role="alert"')).toBeLessThan(
			html.indexOf("Refresh preview</button>"),
		);
	});

	it("disables Refresh preview while a preview is loading", () => {
		expect(retryOpenTag(renderBody(true))).toContain('disabled=""');
	});
});

describe("Combos 44 px targets", () => {
	it("puts the card enable switch in a 44 x 44 label and keeps the title outside it", () => {
		const html = renderCard([]);
		const labelStart = html.indexOf("<label");
		const labelEnd = html.indexOf("</label>");
		expect(labelStart).toBeGreaterThan(-1);
		const labelHtml = html.slice(labelStart, labelEnd);
		const labelTag = html.slice(labelStart, html.indexOf(">", labelStart) + 1);
		expect(labelTag).toContain("h-11");
		expect(labelTag).toContain("w-11");
		expect(labelHtml).toContain('aria-label="Shared priority route enabled"');
		expect(labelHtml).not.toContain("Shared priority route</");
		expect(html.indexOf(">Shared priority route</")).toBeLessThan(labelStart);
		expect(html.indexOf(">Shared priority route</")).toBeGreaterThan(-1);
	});

	it("sizes the Edit and Delete icon buttons to 44 x 44", () => {
		const html = renderCard([]);
		expect(
			tagAround(html, 'aria-label="Edit Shared priority route"'),
		).toContain("h-11 w-11");
		expect(
			tagAround(html, 'aria-label="Delete Shared priority route"'),
		).toContain("h-11 w-11");
	});

	it("gives the drag handle a 44 x 44 hit area and its aria-label", () => {
		const client = builderClient();
		seedBuilder(client);
		client.setQueryData(queryKeys.routingEffective(), []);
		const html = renderBuilder(client);
		const tag = tagAround(html, 'aria-label="Reorder Account one"');
		expect(tag).toContain("h-11");
		expect(tag).toContain("w-11");
		expect(tag).toContain("focus-visible:ring-2");
	});

	it("marks the Managed/Manual mode options with aria-pressed", () => {
		const client = builderClient();
		client.setQueryData(queryKeys.combos(), { combos: [combo] });
		client.setQueryData(queryKeys.families(), {
			families: [assignment("opus", "managed")],
		});
		const html = renderToStaticMarkup(
			<QueryClientProvider client={client}>
				<FamilyActivationSection />
			</QueryClientProvider>,
		);
		// Opus is Managed; the other three families default to Manual.
		expect(html.split('aria-pressed="true"')).toHaveLength(5);
		expect(html.split('aria-pressed="false"')).toHaveLength(5);
		const reviewAt = html.indexOf("Review Managed</button>");
		const buttonStart = html.lastIndexOf("<button", reviewAt);
		expect(
			html.slice(buttonStart, html.indexOf(">", buttonStart) + 1),
		).toContain('aria-pressed="true"');
	});
});
