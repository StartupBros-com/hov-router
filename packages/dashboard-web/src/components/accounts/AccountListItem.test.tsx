/**
 * P2 review fix (U8 OAuth control-plane hotfix): render-level coverage for
 * R25 -- reauthentication must read as the PRIMARY action for a terminal
 * auth pause (pauseReason "oauth_invalid_grant"), while every other pause
 * reason (a known non-terminal reason like "manual", or any unrecognized/
 * legacy string) must fall back to generic "Paused" copy with no reauth
 * emphasis. pause-status.test.ts already unit-tests pauseStatusDisplay()
 * itself; this file proves AccountListItem actually wires that result into
 * the rendered markup (copy + which button reads as primary), the same
 * renderToStaticMarkup pattern RateLimitProgress.test.tsx uses in this
 * directory.
 */
import { describe, expect, it, mock } from "bun:test";
import type { BankedResets, FullUsageData } from "@better-ccflare/types";
import { formatClockTime } from "@better-ccflare/ui-common";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import type { Account } from "../../api";
import { StatusPill } from "../ui/status-pill";
import { AccountList, accountListItems } from "./AccountList";
import {
	AccountListItem,
	CodexCreditDrainControl,
	PublicValueControl,
} from "./AccountListItem";
import { mergeAccountModelMappings } from "./AccountModelMappingsDialog";
import type { AccountFamilyRoutingState } from "./account-routing";
import { STATUS_PILL_TONE, type StatusTone } from "./status-tones";

// Static provider-contract coverage renders the row expanded and all tab bodies.
// Browser acceptance separately drives the real disclosure, tabs and focus behavior.
const tabsPrimitives = await import("../ui/tabs");
mock.module("../ui/tabs", () => ({
	...tabsPrimitives,
	TabsContent: ({
		children,
		value,
	}: {
		children: ReactNode;
		value: string;
	}) => <div data-tab-content={value}>{children}</div>,
}));
// The row's token mark reads a shared query, and the app always renders rows
// inside its QueryClientProvider. With nothing cached the mark renders nothing.
const rowQueryClient = new QueryClient();
function renderClosedMarkup(node: ReactNode): string {
	return renderMarkup(
		<QueryClientProvider client={rowQueryClient}>{node}</QueryClientProvider>,
	);
}

function renderToStaticMarkup(node: ReactNode): string {
	const row = node as ReactElement;
	return renderClosedMarkup(
		row?.type === AccountListItem
			? rowTree(row.props as Parameters<typeof AccountListItem>[0], true)
			: node,
	);
}

function noop() {}
it("keeps the provider text alongside its decorative mark", () => {
	const html = renderClosedMarkup(
		<AccountListItem
			account={makeAccount({ provider: "codex" })}
			{...requiredHandlers}
		/>,
	);
	expect(html).toMatch(
		/<div class="col-start-1 row-start-1 self-center"><svg[^>]*data-provider-mark="openai"[\s\S]*?<\/svg><\/div><div class="col-start-2 row-start-1 flex min-w-0 items-center">[\s\S]*?<span class="inline-flex items-center gap-1.5">codex<\/span>/,
	);
});
it("groups priority rows as flat keyed siblings using rendered counts", () => {
	const now = Date.UTC(2026, 10, 3);
	const accounts = [
		makeAccount({ id: "a", name: "active-a", paused: false }),
		makeAccount({
			id: "b",
			name: "cooldown-b",
			paused: false,
			rateLimitedUntil: now + 60000,
		}),
		makeAccount({ id: "c", name: "paused-c", paused: true }),
	];
	const items = accountListItems(
		{ accounts, ...requiredHandlers },
		"priority",
		now,
	);
	expect(items.map((item) => item.key)).toEqual([
		"group:active",
		"a",
		"b",
		"group:paused",
		"c",
	]);
	expect(items.map((item) => item.type)).toEqual([
		"h2",
		AccountListItem,
		AccountListItem,
		"h2",
		AccountListItem,
	]);
	const html = renderClosedMarkup(items);
	expect(html.match(/<h2\b/g)).toHaveLength(2);
	const visible = html.replace(/<[^>]*>/g, "");
	expect(visible).toContain("Active 2 accounts");
	expect(visible).toContain("Paused 1 account");
	expect(visible).not.toContain("Paused 1 accounts");
	expect(html.indexOf("Active ")).toBeLessThan(html.indexOf("active-a"));
	expect(html.indexOf("cooldown-b")).toBeLessThan(html.indexOf("Paused "));
	expect(html.indexOf("Paused ")).toBeLessThan(html.indexOf("paused-c"));
	expect(
		html.match(/<article[^>]*>/g)?.every((tag) => !tag.includes("opacity")),
	).toBe(true);
	expect(
		renderClosedMarkup(
			accountListItems({ accounts, ...requiredHandlers }, "next-reset", now),
		),
	).not.toContain("<h2");
	expect(
		renderClosedMarkup(
			accountListItems(
				{ accounts: accounts.slice(0, 2), ...requiredHandlers },
				"priority",
				now,
			),
		),
	).not.toContain("Paused ");
});
function withoutDetailsContent(html: string): string {
	const start = html.search(/<section[^>]*aria-label="Details for /);
	if (start < 0) return html;
	const tags = /<section\b[^>]*>|<\/section>/g;
	tags.lastIndex = start;
	let depth = 0;
	for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
		depth += tag[0].startsWith("</") ? -1 : 1;
		if (depth === 0) return html.slice(0, start) + html.slice(tags.lastIndex);
	}
	throw new Error("Unclosed details content");
}
async function noRefreshFailure(): Promise<string | null> {
	return null;
}

describe("account scan layout", () => {
	it("pairs status color with a decorative icon and the unchanged label", () => {
		const examples: {
			input: Partial<Account>;
			tone: StatusTone;
			icon: string;
			label: string;
			detail?: string;
		}[] = [
			{
				input: { rateLimitStatus: "allowed" },
				tone: "ok",
				icon: "circle-check",
				label: "Ready",
			},
			{
				// #917: an Anthropic account's notice comes from its weekly poll.
				input: {
					rateLimitStatus: "OK",
					usageData: {
						limits: [
							{
								kind: "weekly_all",
								percent: 80,
								resets_at: new Date(Date.now() + 86_400_000).toISOString(),
								is_active: true,
							},
						],
					} as unknown as FullUsageData,
				},
				tone: "warning",
				icon: "triangle-alert",
				label: "Near weekly limit",
			},
			{
				input: { rateLimitStatus: "allowed_warning (652m)" },
				tone: "ok",
				icon: "circle-check",
				label: "Ready",
			},
			{
				input: {
					provider: "anthropic-compatible",
					rateLimitStatus: "allowed_warning",
				},
				tone: "warning",
				icon: "triangle-alert",
				label: "Provider warning",
			},
			{
				input: { rateLimitStatus: "blocked" },
				tone: "bad",
				icon: "circle-x",
				label: "Reported hard limit",
			},
			{
				input: { paused: true, pauseReason: "manual" },
				tone: "muted",
				icon: "circle-pause",
				label: "Paused",
			},
			{
				input: { paused: true, pauseReason: "overage" },
				tone: "muted",
				icon: "circle-pause",
				label: "Paused",
				detail: "Auto-paused: overage",
			},
		];
		for (const { input, tone, icon, label, detail } of examples) {
			const html = withoutDetailsContent(
				renderToStaticMarkup(
					<AccountListItem
						account={makeAccount({ paused: false, ...input })}
						{...requiredHandlers}
					/>,
				),
			);
			const start = html.indexOf(
				renderClosedMarkup(<StatusPill tone={STATUS_PILL_TONE[tone]} />)
					.replace("</span>", "")
					.replace(/>$/, ""),
			);
			expect(start).toBeGreaterThanOrEqual(0);
			const pill = html.slice(start, html.indexOf("</span>", start));
			expect(pill).toContain(`lucide-${icon}`);
			expect(pill).toContain('aria-hidden="true"');
			const text = pill.slice(pill.indexOf(">") + 1).replace(/<[^>]*>/g, "");
			expect(text).toBe(label);
			if (detail) expect(html).toContain(`>${detail}<`);
			else expect(html).not.toContain("Auto-paused");
		}
	});
	it("names the weekly window and its use in the Near weekly limit tooltip (#917)", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					paused: false,
					rateLimitStatus: "allowed_warning (652m)",
					usageData: {
						limits: [
							{
								kind: "weekly_all",
								percent: 12,
								resets_at: new Date(Date.now() + 86_400_000).toISOString(),
								is_active: true,
							},
							{
								kind: "weekly_scoped",
								percent: 81.6,
								resets_at: new Date(Date.now() + 86_400_000).toISOString(),
								is_active: false,
								scope: { model: { id: null, display_name: "Fable" } },
							},
						],
					} as unknown as FullUsageData,
				})}
				{...requiredHandlers}
			/>,
		);
		expect(html).toContain(
			'title="Fable weekly use is 82%. Requests still route here."',
		);
		expect(html).not.toContain("Provider reported");
	});
	it("states refresh delay and secondary pacing once per row", () => {
		const soon = Date.now() + 10 * 60 * 1000;
		// Count visible text only; the pill tooltip may repeat the notice.
		const occurrences = (html: string, text: string) =>
			html.replace(/<[^>]*>/g, " ").split(text).length - 1;
		const delayed = withoutDetailsContent(
			renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({
						paused: false,
						rateLimitStatus: "allowed",
						usageRateLimitedUntil: soon,
					})}
					{...requiredHandlers}
				/>,
			),
		);
		expect(occurrences(delayed, "Usage refresh delayed")).toBe(1);
		expect(delayed).toContain(
			'title="Usage refresh delayed; the usage shown may be out of date."',
		);
		const pacedCooldown = withoutDetailsContent(
			renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({
						paused: false,
						rateLimitStatus: "allowed",
						rateLimitedUntil: soon,
						usageThrottledUntil: soon,
						usageThrottledWindows: ["seven_day"],
					})}
					{...requiredHandlers}
				/>,
			),
		);
		expect(pacedCooldown).toContain("Cooling down");
		expect(occurrences(pacedCooldown, "Pacing active")).toBe(1);
		expect(pacedCooldown).not.toContain("may be model-specific");
	});
	it("shows a single cooldown state over saved allowed, and soft observations never promise rejection", () => {
		const cooldown = withoutDetailsContent(
			renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({
						paused: false,
						rateLimitStatus: "allowed",
						rateLimitedUntil: 2000,
					})}
					now={1000}
					{...requiredHandlers}
				/>,
			),
		);
		expect(cooldown).toContain("Cooling down");
		expect(cooldown).toContain("Router retry");
		expect(cooldown).not.toContain(">Ready<");
		for (const rateLimitStatus of [
			"queueing_soft",
			"allowed_warning",
			"future_status",
		]) {
			const html = withoutDetailsContent(
				renderToStaticMarkup(
					<AccountListItem
						account={makeAccount({ paused: false, rateLimitStatus })}
						{...requiredHandlers}
					/>,
				),
			);
			expect(html).not.toContain("Requests are rejected");
			expect(html).not.toContain("Clear cooldown");
			expect(html).not.toContain("not a hard block");
		}
	});
	it("disables both Resume controls for reauthentication pauses", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					paused: true,
					pauseReason: "oauth_invalid_grant",
				})}
				{...requiredHandlers}
			/>,
		);
		const buttons = html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? [];
		// The row's icon button names the account; the Details tab's button keeps its text.
		const iconResume = buttons.filter((b) =>
			b.includes('aria-label="Resume acc-1"'),
		);
		const detailsResume = buttons.filter((b) => b.includes(">Resume account<"));
		expect(iconResume).toHaveLength(1);
		expect(detailsResume).toHaveLength(1);
		for (const button of [...iconResume, ...detailsResume])
			expect(button).toContain("disabled");
	});
	it("distinguishes unavailable data from an empty collection", () => {
		const unavailable = renderToStaticMarkup(
			<AccountList accounts={undefined} {...requiredHandlers} />,
		);
		expect(unavailable).toContain("Account data unavailable");
		expect(unavailable).not.toContain("No accounts yet");
		expect(
			renderToStaticMarkup(<AccountList accounts={[]} {...requiredHandlers} />),
		).toContain("No accounts yet");
	});
	it("renders labeled scan controls and result count", () => {
		const html = renderToStaticMarkup(
			<AccountList accounts={[makeAccount()]} {...requiredHandlers} />,
		);
		for (const text of [
			"Search accounts",
			"All providers",
			"Needs attention",
			"Paused",
			"Showing 1 of 1 accounts",
			"Sort",
			"Next reset (soonest)",
			"Weekly reset (soonest)",
			"5-hour reset (soonest)",
			"Weekly used (lowest first)",
			"5-hour used (lowest first)",
			"Usage and resets",
			'aria-pressed="true"',
		])
			expect(html).toContain(text);
		// The view-order explanation appears only after choosing a non-default sort.
		expect(html).not.toContain("View order only");
	});
	it("collapses routine settings and family details while keeping recovery visible", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ provider: "codex", requiresReauth: true })}
				{...requiredHandlers}
				onCodexReauth={noop}
				onCodexCreditDrainToggle={noop}
				routingStates={[
					routingState({ reason: "ambiguous", reasonLabel: "Ambiguous" }),
				]}
			/>,
		);
		expect(html).toContain('aria-expanded="true"');
		expect(html).not.toContain("<details");
		expect(html).toContain("Use purchased credits");
		const visible = withoutDetailsContent(html);
		expect(visible).toContain("Re-authenticate");
		expect(visible).toContain("Action required");
		expect(visible).not.toContain("No local block");
	});
	it("uses the reported normal state without a duplicate fallback label", () => {
		const allowed = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false, rateLimitStatus: "allowed" })}
				{...requiredHandlers}
			/>,
		);
		expect(withoutDetailsContent(allowed)).toContain("Ready");
		expect(allowed).not.toContain("Provider capacity is not guaranteed");
		expect(allowed).not.toContain("at limit");
		expect(withoutDetailsContent(allowed)).not.toContain("Allowed");
		expect(allowed).not.toContain("No local block");
		const unspecified = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
			/>,
		);
		expect(unspecified).toContain("Ready");
	});
	it("never claims a limit for a provider the router does not poll", () => {
		const cooldownReset = new Date(Date.now() + 3600000).toISOString();
		for (const rateLimitReset of [null, cooldownReset]) {
			const visible = withoutDetailsContent(
				renderToStaticMarkup(
					<AccountListItem
						account={makeAccount({
							paused: false,
							provider: "openai-compatible",
							rateLimitStatus: "allowed",
							rateLimitReset,
						})}
						{...requiredHandlers}
					/>,
				),
			);
			expect(visible).not.toContain("at limit");
			expect(visible).toContain("Quota not tracked");
		}
	});
	it("keeps the name line to the name; plan and Primary join the metadata line", () => {
		const primary = withoutDetailsContent(
			renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({
						paused: false,
						provider: "codex",
						usageData: { plan_type: "pro" } as unknown as FullUsageData,
					})}
					isPrimary
					{...requiredHandlers}
				/>,
			),
		);
		const metadata = primary.indexOf(">codex<");
		expect(metadata).toBeGreaterThan(primary.indexOf("</h3>"));
		expect(primary.indexOf(">Primary<")).toBeGreaterThan(metadata);
		expect(primary.indexOf(">pro<")).toBeGreaterThan(metadata);
		// The Primary marker is drawn inside the row, so no row's content box,
		// and no account name, shifts against the column header.
		const other = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
			/>,
		);
		expect(primary).toContain("shadow-[inset_2px_0_0_var(--color-primary)]");
		expect(other).not.toContain("shadow-[inset_2px_0_0_var(--color-primary)]");
		expect(primary).not.toContain("border-l-");
		expect(other).not.toContain("border-l-");
	});
	it("names a full visible window beside a ready status", () => {
		const reset = new Date(Date.now() + 3600000).toISOString();
		const usageData = {
			seven_day: { utilization: 32, resets_at: reset },
			seven_day_fable: { utilization: 100, resets_at: reset },
		};
		const full = withoutDetailsContent(
			renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({
						paused: false,
						rateLimitStatus: "allowed",
						usageWindow: "seven_day",
						usageUtilization: 32,
						usageData,
					})}
					{...requiredHandlers}
				/>,
			),
		);
		expect(full).toContain("Ready");
		expect(full).toContain("Fable (Weekly) at limit");
		for (const account of [
			makeAccount({
				paused: false,
				usageWindow: "seven_day",
				usageUtilization: 32,
				usageData: {
					...usageData,
					seven_day_fable: { utilization: 99, resets_at: reset },
				},
			}),
			makeAccount({
				paused: true,
				pauseReason: "manual",
				usageWindow: "seven_day",
				usageUtilization: 32,
				usageData,
			}),
		])
			expect(
				withoutDetailsContent(
					renderToStaticMarkup(
						<AccountListItem account={account} {...requiredHandlers} />,
					),
				),
			).not.toContain("at limit");
	});
	it("names a spent family window once, in the status column", () => {
		const reset = new Date(Date.now() + 3600000).toISOString();
		// Both shapes the server sends: the limits[] list and the legacy keys.
		const shapes = [
			{
				limits: [
					{
						kind: "weekly_all",
						percent: 32,
						resets_at: reset,
						is_active: false,
					},
					{
						kind: "weekly_scoped",
						percent: 100,
						resets_at: reset,
						is_active: false,
						scope: { model: { id: "claude-fable-5-2", display_name: "Fable" } },
					},
				],
			},
			{
				seven_day: { utilization: 32, resets_at: reset },
				seven_day_fable: { utilization: 100, resets_at: reset },
			},
		];
		for (const usageData of shapes) {
			const render = (states: AccountFamilyRoutingState[]) =>
				withoutDetailsContent(
					renderToStaticMarkup(
						<AccountListItem
							account={makeAccount({
								paused: false,
								rateLimitStatus: "allowed",
								usageWindow: "seven_day",
								usageUtilization: 32,
								usageData: usageData as Account["usageData"],
							})}
							{...requiredHandlers}
							routingStates={states}
						/>,
					),
				);
			// The family's own bar is full, so the window's label says it and the
			// row adds no "Model exhausted" line under it.
			const covered = render([
				routingState({ family: "fable", availability: "model_exhausted" }),
			]);
			expect(covered).toContain("Ready");
			expect(covered).toContain(">Fable (Weekly) at limit<");
			expect(covered).not.toContain("Model exhausted");
			expect(covered).not.toContain('aria-label="Routing notices"');
			for (const states of [
				[],
				[
					routingState({
						family: "fable",
						availability: "model_exhausted",
						reason: "ambiguous",
						reasonLabel: "Ambiguous",
					}),
				],
				[
					routingState({
						family: "fable",
						availability: "model_exhausted",
						managedRouteAvailable: true,
					}),
				],
				[routingState({ family: "fable", availability: "rate_limited" })],
			]) {
				const visible = render(states);
				expect(visible).toContain(">Fable (Weekly) at limit<");
				expect(visible).not.toContain("Model exhausted");
			}
			// Another family with no full bar of its own joins the same line.
			expect(
				render([
					routingState({ family: "opus", availability: "model_exhausted" }),
				]),
			).toContain(">Fable (Weekly), Opus at limit<");
		}
	});
	it("keeps force reset outside disclosures and missing quota explicit", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					paused: false,
					rateLimitedUntil: Date.now() + 60000,
					usageUtilization: 20,
				})}
				{...requiredHandlers}
			/>,
		);
		const visible = withoutDetailsContent(html);
		expect(visible).toContain("Clear cooldown");
		expect(visible).not.toContain("removes the router’s block");
		expect(visible).toContain("Possible stale cooldown");
		expect(visible).not.toContain("Provider capacity is not guaranteed");
		expect(visible).not.toContain("No local block");
		expect(visible).toContain("Usage unavailable");
	});
	it("explains an Anthropic org refusal and hides Clear cooldown", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					paused: false,
					rateLimitedUntil: Date.now() + 60000,
					rateLimitedReason: "org_permission_denied",
					usageUtilization: 20,
				})}
				{...requiredHandlers}
			/>,
		);
		const visible = withoutDetailsContent(html);
		expect(visible).toContain("Anthropic refused");
		expect(visible).toContain("billing");
		expect(visible).toContain("Router retry");
		expect(visible).not.toContain("Clear cooldown");
		expect(visible).not.toContain("Cooling down");
	});
	it("keeps naming the refusal after the bench lapses while the usage check is refused (#941)", () => {
		// max-quaternary-spgm on 2026-11-21 read "Ready" for 14 hours here.
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					paused: false,
					rateLimitedUntil: null,
					rateLimitedReason: "org_permission_denied",
					usageOrgRefusedAt: Date.now() - 60_000,
				})}
				{...requiredHandlers}
			/>,
		);
		const visible = withoutDetailsContent(html);
		expect(visible).toContain("Anthropic refused");
		expect(visible).toContain("billing");
		expect(visible).not.toContain("Ready");
		expect(visible).not.toContain("Clear cooldown");
		expect(visible).not.toContain("Router retry");
	});
});

function makeAccount(overrides: Partial<Account> = {}): Account {
	return {
		id: "acc-1",
		name: "acc-1",
		provider: "anthropic",
		requestCount: 0,
		totalRequests: 0,
		lastUsed: null,
		created: new Date().toISOString(),
		paused: true,
		requiresReauth: false,
		pauseReason: null,
		tokenStatus: "valid",
		tokenExpiresAt: null,
		rateLimitStatus: "OK",
		rateLimitReset: null,
		rateLimitRemaining: null,
		rateLimitedUntil: null,
		rateLimitedReason: null,
		rateLimitedAt: null,
		sessionInfo: "No active session",
		priority: 0,
		autoFallbackEnabled: false,
		customEndpoint: null,
		modelMappings: null,
		usageUtilization: null,
		usageWindow: null,
		usageData: null,
		usageRateLimitedUntil: null,
		usageThrottledUntil: null,
		usageThrottledWindows: [],
		hasRefreshToken: true,
		sessionStats: null,
		isPrimary: false,
		...overrides,
	};
}

const requiredHandlers = {
	onPauseToggle: noop,
	onForceResetRateLimit: noop,
	onRefreshUsage: noRefreshFailure,
	onRemove: noop,
	onRename: noop,
	onPriorityChange: noop,
	onAutoFallbackToggle: noop,
	onBillingTypeToggle: noop,
};

function routingState(
	overrides: Partial<AccountFamilyRoutingState> = {},
): AccountFamilyRoutingState {
	return {
		family: "opus",
		comboId: "combo-opus",
		comboName: "Opus priority",
		active: true,
		membershipLabel: "Managed",
		tier: 0,
		logicalModel: "claude-opus-4-8",
		reason: "included",
		reasonLabel: "Included",
		availability: "available",
		availabilityLabel: "Available",
		managedRouteAvailable: false,
		...overrides,
	};
}

describe("AccountListItem row actions", () => {
	// Refresh usage, Pause, Details and More sit in the action cluster, in that
	// order, on every row and at every width. Each remedy renders once, beside
	// the status it fixes, at every width.
	function cluster(html: string): string {
		const start = html.indexOf('class="ml-auto flex shrink-0');
		return html.slice(start, html.indexOf("Router status"));
	}
	function statusColumn(html: string): string {
		return html.slice(
			html.indexOf("Router status"),
			html.indexOf("Usage and resets"),
		);
	}
	function buttonWith(html: string, text: string): string | undefined {
		return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find(
			(button) => button.includes(text),
		);
	}
	function classes(element: string | undefined): string[] {
		return (element?.match(/class="([^"]*)"/)?.[1] ?? "").split(/\s+/);
	}
	// Classes that show, hide or move a control by width.
	function widthRules(element: string | undefined): string[] {
		return classes(element).filter(
			(name) =>
				name === "hidden" ||
				/^(?:sm|md|lg|xl|2xl|min-\[[^\]]*\]|max-\[[^\]]*\]|@\[[^\]]*\]):/.test(
					name,
				),
		);
	}
	function retryLineClasses(html: string): string[] | undefined {
		return statusColumn(html)
			.match(/<span class="([^"]*)"><span title="[^"]*">Router retry/)?.[1]
			?.split(/\s+/);
	}
	function visibleRow(account: Account, extra: Record<string, unknown> = {}) {
		return withoutDetailsContent(
			renderToStaticMarkup(
				<AccountListItem account={account} {...requiredHandlers} {...extra} />,
			),
		);
	}

	it("puts Refresh usage first in the action cluster, only where the router can refresh it", () => {
		for (const provider of ["anthropic", "codex"]) {
			const html = visibleRow(makeAccount({ provider, paused: false }));
			const actions = cluster(html);
			const refresh = actions.indexOf('aria-label="Refresh usage for acc-1"');
			expect(refresh).toBeGreaterThan(-1);
			expect(refresh).toBeLessThan(actions.indexOf('aria-label="Pause acc-1"'));
			expect(html.match(/aria-label="Refresh usage/g)).toHaveLength(1);
			expect(widthRules(buttonWith(actions, "Refresh usage"))).toEqual([]);
		}
		for (const provider of ["xai", "openrouter", "zai"]) {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ provider, paused: false })}
					{...requiredHandlers}
				/>,
			);
			expect(html).not.toContain('aria-label="Refresh usage');
		}
	});

	it("stops the refresh spinner for people who turn off animation", () => {
		const refresh = buttonWith(
			cluster(visibleRow(makeAccount())),
			"Refresh usage",
		);
		expect(refresh).toContain("motion-reduce:animate-none");
	});

	it("tops wide rows so the action cluster sits at the same height on every row", () => {
		const html = visibleRow(makeAccount());
		const article = html.slice(
			html.indexOf("<article"),
			html.indexOf(">", html.indexOf("<article")),
		);
		expect(article).toContain("xl:items-start");
		expect(article).not.toContain("items-center");
		// The four controls fit the action column without wrapping.
		expect(article).toContain("_14rem]");
	});

	it("shows Clear cooldown once, after the router retry time, as a bordered button", () => {
		const html = visibleRow(
			makeAccount({
				paused: false,
				rateLimitedUntil: Date.now() + 60_000,
				usageUtilization: 20,
			}),
		);
		expect(html.match(/>Clear cooldown</g)).toHaveLength(1);
		expect(cluster(html)).not.toContain("Clear cooldown");
		const status = statusColumn(html);
		expect(status.indexOf("Router retry")).toBeGreaterThan(-1);
		expect(status.indexOf("Clear cooldown")).toBeGreaterThan(
			status.indexOf("Router retry"),
		);
		const clear = buttonWith(status, "Clear cooldown");
		expect(clear).not.toContain("<svg");
		expect(clear).toContain('aria-label="Clear cooldown for acc-1"');
		// A border, not an underline, marks it as a control, at the status
		// pills' 20px height.
		expect(classes(clear)).toEqual(expect.arrayContaining(["border-2", "h-5"]));
		expect(classes(clear)).not.toContain("underline");
		// A 44px target on a line only a little taller than its text, lifted so
		// the usage block below cannot cover its lower half.
		expect(classes(clear)).toEqual(
			expect.arrayContaining(["after:h-11", "relative", "z-10"]),
		);
		expect(widthRules(clear)).toEqual([]);
		expect(
			widthRules(`<span class="${retryLineClasses(html)?.join(" ")}">`),
		).toEqual([]);
	});

	it("offers Clear cooldown for a clearable hard limit with no retry time", () => {
		const status = statusColumn(
			visibleRow(
				makeAccount({ paused: false, rateLimitStatus: "rate_limited" }),
			),
		);
		expect(status).toContain("Reported hard limit");
		expect(status).not.toContain("Router retry");
		const clear = buttonWith(status, "Clear cooldown");
		expect(clear).toBeDefined();
		const line = status.slice(
			status.lastIndexOf("<span", status.indexOf(clear as string)),
		);
		expect(widthRules(line)).toEqual([]);
	});

	it("shows Re-authenticate once, beside the status it fixes", () => {
		const html = visibleRow(
			makeAccount({ pauseReason: "oauth_invalid_grant" }),
			{ onAnthropicReauth: noop },
		);
		expect(html.match(/>Re-authenticate<\/button>/g)).toHaveLength(1);
		expect(cluster(html)).not.toContain("Re-authenticate");
		const status = statusColumn(html);
		expect(status).toContain("Reconnect required");
		const reauth = reauthButton(status);
		expect(reauth).toContain(" bg-primary ");
		expect(widthRules(reauth)).toEqual([]);
	});

	it("keeps Clear cooldown's tap area off Re-authenticate when both show", () => {
		// The re-login flag is written with a pause, but an unpaused account can
		// still carry it (a failed pause write, or a later resume) while cooling
		// down. Re-authenticate can then sit just above the retry line. Clear
		// cooldown's tap area reaches 12px above the button and the lines are 6px
		// apart, so the retry line gets 6px more.
		const html = visibleRow(
			makeAccount({
				paused: false,
				requiresReauth: true,
				rateLimitedUntil: Date.now() + 60_000,
			}),
			{ onAnthropicReauth: noop },
		);
		const status = statusColumn(html);
		expect(buttonWith(status, "Clear cooldown")).toBeDefined();
		expect(retryLineClasses(html)).toContain("mt-1.5");
		// If text metrics ever shift, the visible button still wins the overlap.
		expect(classes(reauthButton(status))).toEqual(
			expect.arrayContaining(["relative", "z-20"]),
		);
	});

	it("adds no space above the retry line when Re-authenticate is not shown", () => {
		const html = visibleRow(
			makeAccount({ paused: false, rateLimitedUntil: Date.now() + 60_000 }),
		);
		expect(retryLineClasses(html)).toBeDefined();
		expect(
			retryLineClasses(html)?.filter((name) => name.startsWith("mt-")),
		).toEqual([]);
	});

	it("puts the stale warning before the retry time, so the fix comes last", () => {
		// Usage below 100% under a router block reads as a possibly stale cooldown.
		const status = statusColumn(
			visibleRow(
				makeAccount({
					paused: false,
					rateLimitedUntil: Date.now() + 60_000,
					usageUtilization: 20,
				}),
			),
		);
		const stale = status.indexOf("Possible stale cooldown");
		expect(stale).toBeGreaterThan(status.indexOf("Cooling down"));
		expect(status.indexOf("Router retry")).toBeGreaterThan(stale);
		expect(status.indexOf(">Clear cooldown<")).toBeGreaterThan(
			status.indexOf("Router retry"),
		);
	});

	it("keeps the plan and Primary pills from making the identity line taller", () => {
		// On narrow rows the action cluster sits below the name and this line, so
		// a taller line would move Pause, Details and More down on those rows only.
		const html = visibleRow(
			makeAccount({
				provider: "codex",
				usageData: { plan_type: "pro" } as unknown as FullUsageData,
			}),
			{ isPrimary: true },
		);
		const pills =
			html.match(/<span data-tone="(?:secondary|primary)" class="[^"]*"/g) ??
			[];
		expect(pills).toHaveLength(2);
		for (const pill of pills) expect(classes(pill)).toContain("-my-0.5");
		// The 2px overhangs need a 6px gap, or pills on wrapped lines touch.
		const line = html.match(
			/<div class="(col-start-2 row-start-2 [^"]*)"/,
		)?.[1];
		expect(line?.split(/\s+/)).toContain("gap-y-1.5");
	});

	it("keeps a failed refresh's reason for the row it was pressed on", async () => {
		const changes: unknown[] = [];
		const tree = rowTree(
			{
				account: makeAccount(),
				...requiredHandlers,
				onRefreshUsage: async () => "Codex usage endpoint returned 401.",
			},
			false,
			changes,
		);
		const refresh = treeNodes(tree).find(
			(node) => node.props["aria-label"] === "Refresh usage for acc-1",
		);
		await (refresh?.props.onClick as () => Promise<void>)();
		expect(changes).toEqual([
			true,
			"Codex usage endpoint returned 401.",
			false,
		]);
	});

	it("shows that reason under the usage it tried to refresh", () => {
		const html = renderClosedMarkup(
			rowTree({ account: makeAccount(), ...requiredHandlers }, false, [], {
				3: "Codex usage endpoint returned 401.",
			}),
		);
		const usage = html.slice(html.indexOf("Usage and resets"));
		expect(usage).toContain('role="alert"');
		expect(usage).toContain("Codex usage endpoint returned 401.");
	});
});

describe("account model mapping edits", () => {
	it("preserves unrelated exact pins and one-element ordered arrays", () => {
		const existing = {
			"claude-sonnet-4-8": ["private-a", "private-b"],
			fable: ["pinned-a"],
			opus: "pinned-b",
		};
		const merged = mergeAccountModelMappings(existing, {
			fable: "pinned-a",
			opus: "",
			sonnet: "fresh",
			haiku: "",
		});
		expect(merged).toEqual({
			"claude-sonnet-4-8": ["private-a", "private-b"],
			fable: ["pinned-a"],
			sonnet: "fresh",
		});
		expect(existing.opus).toBe("pinned-b");
	});
});

function reauthButton(html: string): string | undefined {
	return (html.match(/<button\b[^>]*>[\s\S]*?<\/button>/g) ?? []).find(
		(button) => button.includes(">Re-authenticate</button>"),
	);
}

describe("AccountListItem (P2 review: pause-reason rendering)", () => {
	it("renders the derived requiresReauth signal as the same primary recovery action", () => {
		const account = makeAccount({
			requiresReauth: true,
			pauseReason: "oauth_invalid_grant",
		});
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Reconnect required");
		expect(html).toContain("Refresh token invalid — re-authenticate");
		expect(html).toContain(">Re-authenticate<");
		expect(reauthButton(html)).toContain(" bg-primary ");
		expect(reauthButton(html)).toContain("text-black");
	});

	it("renders reauth-required copy and a primary Re-authenticate button for oauth_invalid_grant", () => {
		const account = makeAccount({ pauseReason: "oauth_invalid_grant" });
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Reconnect required");
		// The visible button label (as opposed to its static tooltip title,
		// which always reads "Re-authenticate this Anthropic account..."
		// regardless of pause reason) -- ">Re-authenticate<" only appears when
		// pauseStatus.reauthRequired renders the label text inside the button.
		expect(html).toContain(">Re-authenticate<");
		// Assert the recovery button itself, not unrelated switches that also
		// carry bg-primary. Dark ink keeps the primary orange action readable.
		expect(reauthButton(html)).toContain(" bg-primary ");
		expect(reauthButton(html)).toContain("text-black");
	});

	it("renders generic Paused copy with no reauth emphasis for a manual pause", () => {
		const account = makeAccount({ pauseReason: "manual" });
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused");
		expect(html).not.toContain("Reconnect required");
		expect(html).not.toContain(">Re-authenticate<");
		expect(reauthButton(html)).toBeUndefined();
	});

	it("shows a human-readable known automatic pause reason", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ pauseReason: "failure_threshold" })}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain(">Auto-paused: repeated failures<");
		expect(html).not.toContain("Paused (failure threshold)");
	});

	it("renders generic Paused copy with no reauth emphasis for an unrecognized pause reason", () => {
		const account = makeAccount({
			pauseReason: "some_future_reason_this_build_does_not_know_about",
		});
		const html = renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);

		expect(html).toContain("Paused");
		expect(html).not.toContain(
			"some future reason this build does not know about",
		);
		expect(html).not.toContain("Reconnect required");
		expect(html).not.toContain(">Re-authenticate<");
		expect(reauthButton(html)).toBeUndefined();
	});
});

describe("AccountListItem authoritative family routing", () => {
	it("renders server-owned Managed source, model, effective tier, and reason", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[routingState()]}
			/>,
		);

		expect(html).toContain("Family routing");
		expect(html).toContain("Opus");
		expect(html).toContain("Managed");
		expect(html).toContain("claude-opus-4-8");
		expect(html).toContain("Tier 0");
		expect(html).toContain("Included");
	});

	it("renders a Manual membership without duplicating manual_override as a warning", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[
					routingState({
						membershipLabel: "Manual",
						reason: "manual_override",
						reasonLabel: "Manual override",
						tier: 7,
					}),
				]}
			/>,
		);

		expect(html).toContain(">Manual<");
		expect(html).toContain("Tier 7");
		expect(html).not.toContain("Manual override");
		expect(html).not.toContain("Action required");
	});

	for (const [availability, expected] of [
		["paused", "Paused"],
		["requires_reauth", "Needs authentication"],
		["rate_limited", "Rate limited"],
		["model_exhausted", "Model exhausted"],
	] as const) {
		it(`renders the distinct ${availability} operational overlay`, () => {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ paused: false })}
					{...requiredHandlers}
					routingStates={[routingState({ availability })]}
				/>,
			);

			expect(html).toContain(expected);
			expect(html).toContain("route assignment unchanged");
		});
	}

	// The server copies these account-wide states into every family
	// (availabilityFor in account-routing-operations.ts); the status column
	// already shows them once, so the row must not repeat them per family.
	for (const [availability, account, statusLabel] of [
		["paused", { paused: true, pauseReason: "manual" }, "Paused"],
		[
			"requires_reauth",
			{ paused: false, requiresReauth: true },
			"Reconnect required",
		],
		[
			"rate_limited",
			{ paused: false, rateLimitedUntil: Date.now() + 600000 },
			"Cooling down",
		],
	] as const) {
		it(`leaves the account-wide ${availability} state to the status column`, () => {
			const visible = withoutDetailsContent(
				renderToStaticMarkup(
					<AccountListItem
						account={makeAccount(account)}
						{...requiredHandlers}
						routingStates={[
							routingState({ family: "fable", availability }),
							routingState({ availability }),
						]}
					/>,
				),
			);
			expect(visible).not.toContain('aria-label="Routing notices"');
			expect(visible).not.toMatch(/(Fable|Opus): /);
			// The state the row no longer repeats must still be in the status column.
			expect(visible).toContain(`>${statusLabel}<`);
		});
	}

	it("names a spent model family on the status line of a row that still routes", () => {
		const visible = (
			account: Partial<Account>,
			states: AccountFamilyRoutingState[],
		) =>
			withoutDetailsContent(
				renderToStaticMarkup(
					<AccountListItem
						account={makeAccount({ paused: false, ...account })}
						{...requiredHandlers}
						routingStates={states}
					/>,
				),
			);
		// No usage bar shows these families spent, so the status line names them,
		// each once, even when two combos report the same family.
		const states = [
			routingState({ family: "fable", availability: "model_exhausted" }),
			routingState({
				family: "fable",
				comboId: "combo-fable-2",
				availability: "model_exhausted",
			}),
			routingState({ family: "opus", availability: "model_exhausted" }),
		];
		for (const [account, statusLabel] of [
			[{}, "Ready"],
			[{ usageThrottledUntil: Date.now() + 600000 }, "Pacing active"],
		] as const) {
			const row = visible(account, states);
			expect(row).toContain(`>${statusLabel}<`);
			expect(row).toContain(">Fable, Opus at limit<");
			expect(row).not.toContain("Model exhausted");
			expect(row).not.toContain('aria-label="Routing notices"');
		}
		// A blocked account takes no requests at all, which its status already
		// says, so the row names no family (Details still lists each one).
		for (const [account, statusLabel] of [
			[{ rateLimitStatus: "usage_exhausted" }, "Usage exhausted"],
			[{ rateLimitedUntil: Date.now() + 600000 }, "Cooling down"],
			[{ rateLimitStatus: "rate_limited" }, "Reported hard limit"],
			[{ paused: true, pauseReason: "manual" }, "Paused"],
			[{ requiresReauth: true }, "Reconnect required"],
		] as const) {
			const row = visible(account, states);
			expect(row).toContain(`>${statusLabel}<`);
			expect(row).not.toContain("at limit");
			expect(row).not.toContain("Model exhausted");
			expect(row).not.toContain('aria-label="Routing notices"');
		}
	});

	it("keeps availability out of the routing notices that ask for action", () => {
		const notices = (account: Partial<Account>) => {
			const html = withoutDetailsContent(
				renderToStaticMarkup(
					<AccountListItem
						account={makeAccount({ paused: false, ...account })}
						{...requiredHandlers}
						routingStates={[
							routingState({
								family: "fable",
								availability: "model_exhausted",
								reason: "ambiguous",
								reasonLabel: "Ambiguous server proposal",
							}),
							routingState({
								availability: "paused",
								managedRouteAvailable: true,
							}),
						]}
					/>,
				),
			);
			const section = html.match(
				/<section[^>]*aria-label="Routing notices"[^>]*>([\s\S]*?)<\/section>/,
			);
			return [...(section?.[1] ?? "").matchAll(/<p[^>]*>([\s\S]*?)<\/p>/g)].map(
				(p) => p[1].replace(/<[^>]+>/g, ""),
			);
		};
		const expected = [
			"Fable: Action required — Ambiguous server proposal. Review in Combos.",
			"Opus: Managed route available — Review in Combos.",
		];
		expect(notices({})).toEqual(expected);
		expect(notices({ paused: true, pauseReason: "manual" })).toEqual(expected);
	});

	for (const [reason, expected, actionRequired] of [
		["excluded", "Excluded from managed routing", false],
		["unsupported", "Logical model unsupported", false],
		["unknown", "Capability unknown", false],
		["disabled", "Family routing disabled", false],
		["ambiguous", "Ambiguous server proposal", true],
		["new_billing_class", "New billing class requires review", true],
	] as const) {
		it(`renders ${reason} only from the supplied server decision`, () => {
			const html = renderToStaticMarkup(
				<AccountListItem
					account={makeAccount({ paused: false, priority: 0 })}
					{...requiredHandlers}
					routingStates={[
						routingState({
							membershipLabel: null,
							tier: null,
							reason,
							reasonLabel: expected,
						}),
					]}
				/>,
			);

			expect(html).toContain(expected);
			expect(html.includes("Action required")).toBe(actionRequired);
		});
	}

	it("does not infer an outside-route warning from account priority", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false, priority: 0 })}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("Family routing");
		expect(html).not.toContain("Outside active route");
		expect(html).not.toContain("Action required");
	});

	it("directs an outside-route account with a server-approved proposal to Combos without claiming membership", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({ paused: false })}
				{...requiredHandlers}
				routingStates={[
					routingState({
						membershipLabel: null,
						tier: null,
						reason: "unknown",
						reasonLabel: "Capability unknown",
						managedRouteAvailable: true,
					}),
				]}
			/>,
		);

		expect(html).toContain("Managed route available");
		expect(html).toContain("Review in Combos");
		expect(html).toContain("Capability unknown");
		expect(html).not.toContain(">Managed<");
		expect(html).not.toContain("Already a managed member");
	});

	it("keys cards and resolves routing state by immutable account ID", () => {
		const firstRouting = [routingState({ family: "opus" })];
		const secondRouting = [routingState({ family: "fable" })];
		const children = accountListItems({
			accounts: [
				makeAccount({ id: "account-a", name: "duplicate-name" }),
				makeAccount({ id: "account-b", name: "duplicate-name" }),
			],
			routingByAccountId: {
				"account-a": firstRouting,
				"account-b": secondRouting,
			},
			...requiredHandlers,
		});

		expect(children.map((child) => child.key)).toEqual([
			"group:paused",
			"account-a",
			"account-b",
		]);
		expect(children[1]?.props.routingStates).toBe(firstRouting);
		expect(children[2]?.props.routingStates).toBe(secondRouting);
	});
});

describe("AccountListItem codex usage extras", () => {
	// plan_type / credits_balance are polling-only extras from the free
	// wham/usage endpoint (see api-usage.ts) -- NOT part of the public
	// FullUsageData union, so callers cast. Live traffic can overwrite the
	// cached snapshot and drop them at any moment, so every read must be
	// null-safe and simply omit the element when absent (see
	// RateLimitProgress.tsx's CodexUsageExtras for the sibling code_review_*
	// extras, which follow the same contract).
	function codexUsageData(
		extras: Record<string, unknown>,
	): NonNullable<Account["usageData"]> {
		return {
			five_hour: { utilization: 10, resets_at: null },
			seven_day: { utilization: 20, resets_at: null },
			...extras,
		} as unknown as FullUsageData;
	}

	it("renders a plan_type badge near the account name when present", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ plan_type: "pro" }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).toContain(">pro<");
	});

	it("omits the plan_type badge when absent from usageData", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain(">pro<");
	});

	it("renders credits_balance as a compact stat when positive", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: 1234 }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).toContain("1,234 credits");
	});

	it("omits the credits_balance stat when it is zero (noise, not a real balance)", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: 0 }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
		expect(html).not.toContain("0 credits");
	});

	it("omits the credits_balance stat when absent from usageData", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
	});

	it("omits the credits_balance stat when null", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					usageData: codexUsageData({ credits_balance: null }),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain("credits</span>");
	});

	it("does not render plan_type or credits_balance extras for non-codex providers even if the shape is present", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "anthropic",
					usageData: codexUsageData({
						plan_type: "pro",
						credits_balance: 1234,
					}),
				})}
				{...requiredHandlers}
			/>,
		);

		expect(html).not.toContain(">pro<");
		expect(html).not.toContain("1,234 credits");
	});
});

describe("AccountListItem (binding constraint display)", () => {
	function render(account: Account): string {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAnthropicReauth={noop}
			/>,
		);
	}

	it("renders nothing when the server sent no binding constraint", () => {
		// Older servers omit the field entirely — no empty row, no placeholder.
		const html = render(makeAccount({ paused: false }));
		expect(html).not.toContain("Closest limit");
	});

	it("marks a family-scoped cap as not counted in the routing percentage", () => {
		// The 2026-08-11 incident: routing badge reads 64% account-wide while a
		// per-model weekly cap sits at 100% and that lane is unroutable.
		const html = render(
			makeAccount({
				paused: false,
				usageUtilization: 64,
				usageWindow: "five_hour",
				bindingConstraint: {
					window: "seven_day_fable",
					utilization: 100,
					resetAtMs: 1_800_000_000_000,
					scope: "family",
					modelFamily: "fable",
				},
			}),
		);

		expect(html).toContain("Closest limit");
		expect(html).toContain("Fable (Weekly)");
		expect(html).toContain("100%");
		expect(html).toContain(
			"applies to this model, separate from account-wide usage",
		);
	});

	it("labels an account-wide constraint as account-wide", () => {
		const html = render(
			makeAccount({
				paused: false,
				usageUtilization: 64,
				usageWindow: "five_hour",
				bindingConstraint: {
					window: "five_hour",
					utilization: 64,
					resetAtMs: 1_800_000_000_000,
					scope: "account",
					modelFamily: null,
				},
			}),
		);

		expect(html).toContain("Closest limit");
		expect(html).toContain("5-hour");
		expect(html).toContain("account-wide");
		expect(html).not.toContain("limit for this model");
		expect(html).not.toContain("applies to this model");
	});

	it("keeps the routing utilization badge alongside the binding constraint", () => {
		// The binding constraint must ADD an answer, never replace the routing
		// one — the two questions are different and collapsing them is the bug.
		const html = render(
			makeAccount({
				paused: false,
				usageUtilization: 64,
				usageWindow: "five_hour",
				usageData: {
					five_hour: { utilization: 64, resets_at: null },
				} as FullUsageData,
				bindingConstraint: {
					window: "seven_day_fable",
					utilization: 100,
					resetAtMs: null,
					scope: "family",
					modelFamily: "fable",
				},
			}),
		);

		expect(html).toContain("Closest limit");
		expect(html).toContain("64%");
		expect(html).toContain("100%");
	});
});

describe("AccountListItem Codex credit drain toggle", () => {
	function render(
		account: Account,
		onCodexCreditDrainToggle?: (a: Account) => void,
	) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onCodexCreditDrainToggle={onCodexCreditDrainToggle}
			/>,
		);
	}

	it("renders the Use purchased credits switch for codex rows with the spend warning", () => {
		const html = render(makeAccount({ provider: "codex" }), noop);
		expect(html).toContain("Use purchased credits");
		expect(html).toContain("spends purchased credits");
	});

	it("does not render for non-codex rows or without a handler", () => {
		expect(render(makeAccount({ provider: "anthropic" }), noop)).not.toContain(
			"Use purchased credits",
		);
		expect(render(makeAccount({ provider: "codex" }))).not.toContain(
			"Use purchased credits",
		);
	});

	it("reflects codexCreditDrainEnabled", () => {
		const on = render(
			makeAccount({ provider: "codex", codexCreditDrainEnabled: true }),
			noop,
		);
		const off = render(makeAccount({ provider: "codex" }), noop);
		const drainSwitch = (html: string) =>
			html.slice(html.indexOf("Use purchased credits"));
		expect(drainSwitch(on)).toContain('aria-checked="true"');
		expect(drainSwitch(off)).not.toContain('aria-checked="true"');
	});

	it("calls the handler with the account when toggled", () => {
		const account = makeAccount({ provider: "codex" });
		const calls: Account[] = [];
		const el = CodexCreditDrainControl({
			account,
			onToggle: (a: Account) => calls.push(a),
		});
		const found = findSwitch(el);
		expect(found).not.toBeNull();
		found?.onCheckedChange?.(true);
		expect(calls).toEqual([account]);
	});

	it("shows the on-credits indicator only when drain is serving from credits", () => {
		const serving = render(
			makeAccount({
				provider: "codex",
				codexCreditDrainEnabled: true,
				codexCreditDrainActive: true,
				codexCreditDrainServing: true,
			}),
			noop,
		);
		const armedOnly = render(
			makeAccount({
				provider: "codex",
				codexCreditDrainEnabled: true,
				codexCreditDrainActive: true,
				codexCreditDrainServing: false,
			}),
			noop,
		);
		const inactive = render(
			makeAccount({ provider: "codex", codexCreditDrainEnabled: true }),
			noop,
		);
		expect(serving).toContain("on credits");
		expect(armedOnly).not.toContain("on credits");
		expect(inactive).not.toContain("on credits");
	});
});

describe("AccountListItem banked resets", () => {
	const NOV_30 = Date.UTC(2026, 10, 30);
	const tracked: BankedResets = {
		tracked: true,
		availableCount: 2,
		applicableCount: 2,
		soonestExpiresAt: NOV_30,
		doesNotExpire: false,
		appliesNow: true,
		stale: false,
		observedAt: Date.now(),
	};

	function render(account: Account) {
		return renderToStaticMarkup(
			<AccountListItem account={account} {...requiredHandlers} />,
		);
	}

	function codex(bankedResets: BankedResets | undefined) {
		return makeAccount({ provider: "codex", paused: false, bankedResets });
	}

	it("renders full banked reset controls as their own group below Usage statistics", () => {
		const html = render(codex(tracked));
		const group = html.indexOf(
			'<fieldset aria-label="Banked resets for acc-1"',
			html.indexOf('data-tab-content="usage"'),
		);
		expect(group).toBeGreaterThan(-1);
		expect(html).toContain("cannot be undone");
		expect(html).not.toMatch(/would help|expected to help|applies now/i);
		// The status line closes before the group opens: the group is not one of
		// its chips, so it cannot wrap in among the request counters.
		const statusLine = html.indexOf("0 requests");
		expect(statusLine).toBeGreaterThan(-1);
		expect(html.slice(statusLine, group)).toContain("</div>");
	});

	it("never colours a held reset green in the row", () => {
		const html = render(codex(tracked));
		const group = html.slice(html.indexOf("<fieldset"));
		expect(group.slice(0, group.indexOf("</fieldset>"))).not.toMatch(
			/bg-green|text-green/,
		);
	});

	it("shows nothing for accounts without the field or other providers", () => {
		expect(render(codex(undefined))).not.toContain("Banked resets");
		expect(
			render(
				makeAccount({
					provider: "anthropic",
					paused: false,
					bankedResets: tracked,
				}),
			),
		).not.toContain("Banked resets");
	});

	it("offers Use reset only when the list is given a handler", () => {
		// Static markup cannot click, so this covers the pass-through from the
		// list to the row's status block, not the click itself.
		const useResetButton = /<button\b[^>]*>Use reset<\/button>/;
		const accounts = [codex(tracked)];
		expect(
			renderToStaticMarkup(
				<AccountList accounts={accounts} {...requiredHandlers} />,
			),
		).not.toMatch(useResetButton);
		expect(
			renderToStaticMarkup(
				<AccountList
					accounts={accounts}
					{...requiredHandlers}
					onUseReset={() => {}}
				/>,
			),
		).toMatch(useResetButton);
	});
});

describe("AccountListItem header at phone width", () => {
	// At 390px a rate-limited card put Clear cooldown, Refresh usage, Pause and More
	// beside the name. The name column had a zero flex basis, so it got the ~48px
	// left over and `overflow-wrap: anywhere` split "pro-primary-wmgm" into five
	// mid-word pieces. The column now claims 8rem before the actions may sit
	// beside it, and the name breaks at hyphens before it breaks mid-word.
	function header() {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					name: "pro-primary-wmgm",
					provider: "codex",
					paused: false,
					rateLimitedUntil: Date.now() + 3_600_000,
				})}
				{...requiredHandlers}
			/>,
		);
		const nameEnd = html.indexOf(">pro-primary-wmgm</h3>");
		const headingStart = html.lastIndexOf("<h3", nameEnd);
		const columnStart = html.lastIndexOf(
			'<div class="grid min-w-0',
			headingStart,
		);
		return {
			html,
			heading: html.slice(headingStart, nameEnd),
			column: html.slice(columnStart, html.indexOf(">", columnStart)),
		};
	}

	it("gives the name column a real basis so the actions wrap below it", () => {
		const { html, column } = header();
		expect(html).toContain("Clear cooldown");
		expect(column).toContain(
			"basis-full grid-cols-[1rem_minmax(0,1fr)] gap-x-2 gap-y-1 sm:basis-auto sm:flex-[1_1_8rem]",
		);
		expect(column).not.toMatch(/\bflex-1\b/);
		expect(html).toContain('class="ml-auto flex shrink-0 flex-wrap');
	});

	it("breaks a long name at its hyphens, not anywhere", () => {
		const { heading } = header();
		expect(heading).toContain("break-words");
		expect(heading).not.toContain("anywhere");
	});
});

type SwitchProps = { onCheckedChange?: (v: boolean) => void };
function findSwitch(node: unknown): SwitchProps | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const n of node) {
			const r = findSwitch(n);
			if (r) return r;
		}
		return null;
	}
	const props = (node as { props?: Record<string, unknown> }).props;
	if (!props) return null;
	if (
		typeof props.title === "string" &&
		props.title.includes("purchased credits") &&
		typeof props.onCheckedChange === "function"
	) {
		return props as SwitchProps;
	}
	return findSwitch(props.children);
}

describe("AccountListItem public value toggle", () => {
	function render(
		account: Account,
		onPublicValueToggle?: (a: Account) => void,
		onPublicValueEditLabel?: (a: Account) => void,
	) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onPublicValueToggle={onPublicValueToggle}
				onPublicValueEditLabel={onPublicValueEditLabel}
			/>,
		);
	}

	it("renders for every provider and not without a handler", () => {
		for (const provider of ["anthropic", "codex", "zai"]) {
			expect(render(makeAccount({ provider }), noop)).toContain(
				"Share value publicly",
			);
		}
		expect(render(makeAccount())).not.toContain("Share value publicly");
	});

	it("reflects publicValueEnabled", () => {
		const on = render(makeAccount({ publicValueEnabled: true }), noop);
		const off = render(makeAccount(), noop);
		const sw = (html: string) =>
			html.slice(html.indexOf("Share value publicly"));
		expect(sw(on)).toContain('aria-checked="true"');
		expect(sw(off)).not.toContain('aria-checked="true"');
	});

	it("shows the label and edit action only when published", () => {
		const on = render(
			makeAccount({ publicValueEnabled: true, publicValueLabel: "Max #1" }),
			noop,
			noop,
		);
		expect(on).toContain("Max #1");
		expect(on).toContain("Edit public label");
		// A kept label is not shown while unpublished.
		const off = render(
			makeAccount({ publicValueEnabled: false, publicValueLabel: "Max #1" }),
			noop,
			noop,
		);
		expect(off).not.toContain("Max #1");
		expect(off).not.toContain("Edit public label");
	});

	it("calls the toggle handler with the account when switched", () => {
		const account = makeAccount();
		const calls: Account[] = [];
		const el = PublicValueControl({
			account,
			onToggle: (a: Account) => calls.push(a),
		});
		const found = findSwitchByTitle(el, "House of Vibe");
		expect(found).not.toBeNull();
		found?.onCheckedChange?.(true);
		expect(calls).toEqual([account]);
	});
});

describe("AccountListItem row layout", () => {
	function render(account: Account) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onCustomEndpointChange={noop}
				onModelMappingsChange={noop}
			/>,
		);
	}

	it("surfaces a custom endpoint and the mapping count as visible chips", () => {
		const html = render(
			makeAccount({
				provider: "openai-compatible",
				customEndpoint: "https://gateway.example/v1",
				modelMappings: { opus: "a", sonnet: "b" },
			}),
		);
		expect(html).toContain("custom endpoint");
		expect(html).toContain(
			'title="Custom endpoint: https://gateway.example/v1"',
		);
		expect(html).toContain("2 model mappings");
	});

	it("uses the singular for one mapping and omits both chips when unset", () => {
		expect(render(makeAccount({ modelMappings: { opus: "a" } }))).toContain(
			"1 model mapping<",
		);
		const bare = render(makeAccount());
		expect(bare).not.toContain("custom endpoint");
		expect(bare).not.toContain("model mapping");
	});

	it("shows Bedrock profile details instead of a raw endpoint chip", () => {
		const html = render(
			makeAccount({
				provider: "bedrock",
				customEndpoint: "bedrock:dev-profile:us-east-1",
			}),
		);
		expect(html).toContain("Profile: dev-profile");
		expect(html).toContain("us-east-1");
		expect(html).not.toContain("custom endpoint");
	});

	it("hides the API's empty session placeholders but keeps an active session", () => {
		for (const sessionInfo of ["-", "No active session", ""]) {
			const html = render(makeAccount({ sessionInfo }));
			expect(html).not.toContain(">-<");
			expect(html).not.toContain("No active session");
		}
		expect(render(makeAccount({ sessionInfo: "Active: 12 reqs" }))).toContain(
			"Active: 12 reqs",
		);
	});

	it("groups request counts with thousands separators", () => {
		expect(render(makeAccount({ requestCount: 949516 }))).toContain(
			"949,516 requests",
		);
	});

	it("gives every icon-only action an accessible name", () => {
		const paused = render(makeAccount({ name: "max-a", paused: true }));
		expect(paused).toContain('aria-label="Resume max-a"');
		expect(paused).toContain('aria-label="More actions for max-a"');
		expect(paused).toContain('aria-label="Refresh usage for max-a"');
		expect(render(makeAccount({ paused: false }))).toContain(
			'aria-label="Pause acc-1"',
		);
	});

	it("keeps the closed overflow menu's actions out of the row markup", () => {
		const html = render(makeAccount());
		expect(html).not.toContain("Remove account");
		expect(html).not.toContain("Rename…");
	});
});

function findSwitchByTitle(
	node: unknown,
	titlePart: string,
): SwitchProps | null {
	if (!node || typeof node !== "object") return null;
	if (Array.isArray(node)) {
		for (const n of node) {
			const r = findSwitchByTitle(n, titlePart);
			if (r) return r;
		}
		return null;
	}
	const props = (node as { props?: Record<string, unknown> }).props;
	if (!props) return null;
	if (
		typeof props.title === "string" &&
		props.title.includes(titlePart) &&
		typeof props.onCheckedChange === "function"
	) {
		return props as SwitchProps;
	}
	return findSwitchByTitle(props.children, titlePart);
}

describe("account settings switches", () => {
	function render(account: Account) {
		return renderToStaticMarkup(
			<AccountListItem
				account={account}
				{...requiredHandlers}
				onAutoPauseOnOverageToggle={noop}
				onPeakHoursPauseToggle={noop}
			/>,
		);
	}

	it("gives settings switches explicit 44px targets independent of their borders", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		const switches = html.match(/<button[^>]*role="switch"[^>]*>/g) ?? [];
		expect(switches.length).toBe(2);
		for (const control of switches) {
			expect(control).toContain("after:h-11");
			expect(control).toContain("after:w-11");
			expect(control).toContain("after:-translate-x-1/2");
			expect(control).toContain("after:-translate-y-1/2");
		}
	});

	it("offers auto-fallback but no auto-refresh switch on an Anthropic row", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		expect(html).toContain("Return after reset");
		expect(html).not.toContain("Auto-refresh");
	});

	it("explains automatic return and the best-effort extra-usage switch in visible text", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		const text = html.replace(/<[^>]+>/g, "");
		expect(text).toContain("Switch back from lower-priority accounts");
		expect(text).toContain(
			"Best effort: Anthropic can bill a request before the router learns that a limit is spent. The router never changes your setting at Anthropic.",
		);
	});

	it("keeps the peak-hours toggle on a zai row", () => {
		const html = render(makeAccount({ provider: "zai" }));
		expect(html).toContain("Pause during peak hours");
		expect(html.replace(/<[^>]+>/g, "")).toContain(
			"Pause Monday–Friday from 14:00–18:00 Singapore time.",
		);
		expect(html).not.toContain("Pause daily");
		expect(html).not.toContain("Auto-refresh");
	});

	it("says an overage pause resumes at window reset only with auto-fallback on", () => {
		const html = render(makeAccount({ provider: "anthropic" }));
		expect(html).toContain(
			"A login paused for extra usage comes back when you resume it, or after its stored reset time only if Return after reset is on.",
		);
	});
});

describe("extra usage on a Claude row", () => {
	const now = Date.UTC(2026, 10, 16, 12, 0);
	const HOUR = 60 * 60 * 1000;
	const LABEL = "Don’t use extra usage on this login";
	const text = (html: string) => html.replace(/<[^>]+>/g, "");
	function props(overrides: Partial<Account>) {
		return {
			now,
			account: makeAccount({ paused: false, ...overrides }),
			...requiredHandlers,
			onAutoPauseOnOverageToggle: noop,
		};
	}
	// Closed: Details is collapsed, so this is what the member sees at a glance.
	const closed = (overrides: Partial<Account>) =>
		renderClosedMarkup(<AccountListItem {...props(overrides)} />);
	const opened = (overrides: Partial<Account>) =>
		renderToStaticMarkup(<AccountListItem {...props(overrides)} />);

	// What a collapsed row shows: Details content stripped, as the member sees it at a glance.
	const glance = (overrides: Partial<Account>) =>
		withoutDetailsContent(closed(overrides));
	const SETTINGS_LINK = 'href="https://claude.ai/settings/usage"';

	it("shows extra usage on as one warning pill, with the state, warning and link in Settings", () => {
		const readingAt = now - 60_000;
		const account = { extraUsage: { state: "on" as const, readingAt } };
		const row = glance(account);
		expect(text(row)).toContain("Extra usage on");
		expect(row).toMatch(/data-tone="warning"[^>]*>Extra usage on</);
		expect(text(row)).not.toContain("Anthropic bills");
		expect(text(row)).not.toContain("Extra usage is on at Anthropic");
		expect(row).not.toContain(SETTINGS_LINK);

		const html = opened(account);
		expect(text(html)).toContain(
			`Extra usage is on at Anthropic as of ${formatClockTime(readingAt, now)}.`,
		);
		expect(text(html)).toContain(
			"Anthropic bills this login’s requests past a spent plan limit.",
		);
		expect(html).toContain(SETTINGS_LINK);
	});

	it("names the switch with its best-effort text in Settings", () => {
		const html = opened({ extraUsage: { state: "on", readingAt: now } });
		expect(text(html)).toContain(LABEL);
		expect(text(html)).toContain(
			"Best effort: Anthropic can bill a request before the router learns that a limit is spent.",
		);
		expect(html).toContain('aria-label="Don’t use extra usage on acc-1"');
	});

	it("says nothing about extra usage on a collapsed row while it reads off", () => {
		const account = { extraUsage: { state: "off" as const, readingAt: now } };
		const row = glance(account);
		expect(text(row)).not.toContain("Extra usage");
		expect(row).not.toContain(SETTINGS_LINK);
		expect(row).not.toContain('data-tone="warning"');

		const html = opened(account);
		expect(text(html)).toContain(
			`Extra usage is off at Anthropic as of ${formatClockTime(now, now)}.`,
		);
		expect(text(html)).not.toContain("bills");
		expect(html).toContain(SETTINGS_LINK);
		expect(html).toContain('aria-label="Don’t use extra usage on acc-1"');
	});

	it("says nothing on a collapsed row while the state is not known, and says not known in Settings", () => {
		const account = {
			extraUsage: { state: "unknown" as const, readingAt: null },
		};
		expect(text(glance(account))).not.toContain("Extra usage");
		const html = opened(account);
		expect(text(html)).toContain("Extra usage at Anthropic is not known.");
		expect(text(html)).not.toContain("off at Anthropic");
		expect(text(html)).not.toContain("last reading");
	});

	it("shows a model hold as a short cue on a collapsed row and in full in Settings", () => {
		const resetsAtMs = now + 3 * HOUR;
		const account = {
			autoPauseOnOverageEnabled: true,
			extraUsage: { state: "on" as const, readingAt: now },
			extraUsageHolds: [
				{
					windowKey: "seven_day_opus",
					scope: "family" as const,
					modelFamily: "opus",
					resetsAtMs,
					startedAt: now - HOUR,
				},
			],
		};
		const time = formatClockTime(resetsAtMs, now);
		expect(text(glance(account))).toContain(`Opus held until ${time}`);
		expect(text(glance(account))).not.toContain("Held:");
		expect(text(opened(account))).toContain(
			`Held: Opus — Opus (Weekly) limit spent. Ends at ${time} or when you turn the switch off.`,
		);
	});

	it("keeps the hold cue when nothing else on the row says the model is held", () => {
		// A stored hold outlives a failed usage reading, and a paused row hides
		// the at-limit labels, so only the cue says Opus is held and until when.
		const resetsAtMs = now + 3 * HOUR;
		const row = text(
			glance({
				paused: true,
				pauseReason: "manual",
				autoPauseOnOverageEnabled: true,
				extraUsage: { state: "off", readingAt: now },
				extraUsageHolds: [
					{
						windowKey: "seven_day_opus",
						scope: "family",
						modelFamily: "opus",
						resetsAtMs,
						startedAt: now - HOUR,
					},
				],
			}),
		);
		expect(row).toContain(
			`Opus held until ${formatClockTime(resetsAtMs, now)}`,
		);
		expect(row).not.toContain("at limit");
	});

	it("drops the at-limit label for a window the router holds, since the cue says it", () => {
		const resetsAtMs = now + 3 * HOUR;
		const resets_at = new Date(resetsAtMs).toISOString();
		const scoped = (id: string, display_name: string) => ({
			kind: "weekly_scoped",
			percent: 100,
			resets_at,
			is_active: false,
			scope: { model: { id, display_name } },
		});
		const account = (switchOn: boolean) => ({
			paused: false,
			rateLimitStatus: "allowed",
			usageWindow: "seven_day",
			usageUtilization: 32,
			usageData: {
				limits: [
					{ kind: "weekly_all", percent: 32, resets_at, is_active: false },
					scoped("opus", "Opus"),
					scoped("fable", "Fable"),
				],
			},
			autoPauseOnOverageEnabled: switchOn,
			extraUsage: { state: "off" as const, readingAt: now },
			extraUsageHolds: [
				{
					windowKey: "seven_day_opus",
					scope: "family" as const,
					modelFamily: "opus",
					resetsAtMs,
					startedAt: now - HOUR,
				},
			],
		});
		// Without a hold the status column names both spent windows. The usage
		// column names Opus (Weekly) either way, so check the label, not the name.
		expect(text(glance(account(false)))).toContain(
			"Opus (Weekly), Fable (Weekly) at limit",
		);
		const row = text(glance(account(true)));
		expect(row).toContain("Ready");
		expect(row).toContain(
			`Opus held until ${formatClockTime(resetsAtMs, now)}`,
		);
		expect(row).not.toContain("Opus (Weekly), ");
		expect(row).not.toContain("Opus (Weekly) at limit");
		// A spent window with no hold still says so.
		expect(row).toContain("Fable (Weekly) at limit");
		// A spent family whose window is held or shown full adds nothing more.
		const routed = text(
			withoutDetailsContent(
				renderClosedMarkup(
					<AccountListItem
						{...props(account(true))}
						routingStates={[
							routingState({ family: "opus", availability: "model_exhausted" }),
							routingState({
								family: "fable",
								availability: "model_exhausted",
							}),
						]}
					/>,
				),
			),
		);
		expect(routed).toContain("Fable (Weekly) at limit");
		expect(routed).not.toContain("Opus at limit");
		expect(routed).not.toContain("Fable at limit");
		expect(routed).not.toContain("Model exhausted");
	});

	it("shows one cue on a row whose whole-login hold outlasts its model hold", () => {
		const row = text(
			glance({
				paused: true,
				pauseReason: "manual",
				autoPauseOnOverageEnabled: true,
				extraUsage: { state: "off", readingAt: now },
				extraUsageHolds: [
					{
						windowKey: "seven_day_opus",
						scope: "family",
						modelFamily: "opus",
						resetsAtMs: now + 3 * HOUR,
						startedAt: now - HOUR,
					},
					{
						windowKey: "seven_day",
						scope: "account",
						modelFamily: null,
						resetsAtMs: now + 40 * HOUR,
						startedAt: now - HOUR,
					},
				],
			}),
		);
		expect(row).toContain(
			`All models held until ${formatClockTime(now + 40 * HOUR, now)}`,
		);
		expect(row).not.toContain("Opus held until");
	});

	it("leaves a billed hold to the row's Paused status and puts its cause and end in Settings", () => {
		const billedAt = now - HOUR;
		const account = {
			paused: true,
			pauseReason: "overage",
			autoPauseOnOverageEnabled: true,
			rateLimitReset: new Date(now + 2 * HOUR).toISOString(),
			extraUsage: { state: "on" as const, readingAt: now },
			extraUsageBilledHold: { billedAt, family: "opus" },
		};
		const row = text(glance(account));
		expect(row).toContain("Paused");
		expect(row).toContain("Auto-paused: overage");
		expect(row).not.toContain("Held:");
		expect(row).not.toContain("held until");
		expect(text(opened(account))).toContain(
			`Held: Every model — Anthropic billed an Opus request as extra usage at ${formatClockTime(billedAt, now)}. Ends when you resume this login or when you turn the switch off.`,
		);
	});

	it("adds the stored reset time to a billed hold with Return after reset on", () => {
		const reset = now + 2 * HOUR;
		const html = opened({
			paused: true,
			pauseReason: "overage",
			autoPauseOnOverageEnabled: true,
			autoFallbackEnabled: true,
			rateLimitReset: new Date(reset).toISOString(),
			extraUsage: { state: "on", readingAt: now },
			extraUsageBilledHold: { billedAt: now - HOUR, family: "opus" },
		});
		expect(text(html)).toContain(
			`Ends when you resume this login, after ${formatClockTime(reset, now)} or when you turn the switch off.`,
		);
	});

	it("shows the state in Settings even when the row has no switch handler", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				now={now}
				account={makeAccount({
					paused: false,
					extraUsage: { state: "off", readingAt: now },
				})}
				{...requiredHandlers}
			/>,
		);
		expect(text(html)).toContain("Extra usage is off at Anthropic as of");
		expect(html).toContain(SETTINGS_LINK);
		expect(html).not.toContain('aria-label="Don’t use extra usage on acc-1"');
	});

	it("no longer shows Pause on extra usage anywhere on the row", () => {
		const html = opened({
			autoPauseOnOverageEnabled: true,
			extraUsage: { state: "on", readingAt: now },
		});
		expect(html).not.toContain("Pause on extra usage");
		expect(text(html)).toContain(LABEL);
	});

	it("keeps today's pause status for an overage pause with the switch off", () => {
		const html = withoutDetailsContent(
			closed({
				paused: true,
				pauseReason: "overage",
				autoPauseOnOverageEnabled: false,
				extraUsage: { state: "on", readingAt: now },
				extraUsageBilledHold: null,
			}),
		);
		expect(text(html)).toContain("Paused");
		expect(text(html)).toContain("Auto-paused: overage");
		expect(text(html)).not.toContain("Held:");
	});

	it("shows nothing about extra usage on another provider's row", () => {
		const html = opened({ provider: "codex" });
		expect(text(html)).not.toContain("Extra usage on");
		expect(text(html)).not.toContain("at Anthropic");
		expect(html).not.toContain("claude.ai/settings/usage");
	});

	it("calls the old route's toggle with the account when switched", () => {
		const account = makeAccount({ paused: false });
		const calls: Account[] = [];
		const tree = rowTree(
			{
				now,
				account,
				...requiredHandlers,
				onAutoPauseOnOverageToggle: (a: Account) => calls.push(a),
			},
			true,
		);
		const found = findSwitchByTitle(tree, "comes back when you resume it");
		expect(found).not.toBeNull();
		found?.onCheckedChange?.(true);
		expect(calls).toEqual([account]);
	});
});

describe("compact hybrid list", () => {
	it("keeps an empty fresh banked balance in Details, while held resets stay visible", () => {
		const html = renderToStaticMarkup(
			<AccountListItem
				account={makeAccount({
					provider: "codex",
					bankedResets: {
						tracked: true,
						availableCount: 0,
						applicableCount: 0,
						soonestExpiresAt: null,
						doesNotExpire: false,
						appliesNow: false,
						stale: false,
						observedAt: Date.now(),
					},
				})}
				{...requiredHandlers}
			/>,
		);
		expect(html).toContain("Banked resets:");
		expect(withoutDetailsContent(html)).not.toContain("Banked resets:");
	});
	it("offers a global review action and aligned comparison headings", () => {
		const html = renderToStaticMarkup(
			<AccountList
				accounts={[makeAccount({ requiresReauth: true })]}
				{...requiredHandlers}
			/>,
		);
		expect(html).toContain('aria-label="Attention across all accounts"');
		expect(html).toContain("1 needs attention");
		expect(html).toContain("Review accounts");
		expect(html).toContain("Router status");
		expect(html).toContain("Usage and resets");
		expect(withoutDetailsContent(html)).toContain("Usage unavailable");
	});
	it("starts collapsed with a button controlling an inline account region", () => {
		const html = renderClosedMarkup(
			<AccountListItem account={makeAccount()} {...requiredHandlers} />,
		);
		const trigger = html.match(
			/<button[^>]*aria-label="Details for acc-1"[^>]*>/,
		)?.[0];
		expect(trigger).toBeDefined();
		expect(trigger).toContain('aria-expanded="false"');
		expect(trigger).not.toContain('aria-haspopup="dialog"');
		const regionId = trigger?.match(/aria-controls="([^"]+)"/)?.[1];
		expect(regionId).toBeTruthy();
		expect(html).toContain(`<section id="${regionId}"`);
		expect(html).not.toContain('role="tablist"');
	});
});

describe("Details settings errors", () => {
	it("passes only the matching account error and renders its alert inside Details", () => {
		const account = makeAccount();
		const items = accountListItems({
			accounts: [account, makeAccount({ id: "other" })],
			...requiredHandlers,
			settingsErrors: { [account.id]: "Setting failed" },
		});
		expect(items[1]?.props.settingsError).toBe("Setting failed");
		expect(items[2]?.props.settingsError).toBeUndefined();
		const html = renderToStaticMarkup(items[1]);
		expect(html).toContain('role="alert"');
		expect(html).toContain("Setting failed");
		expect(withoutDetailsContent(html)).not.toContain("Setting failed");
	});
	it("clears the matching error when opening and collapsing Details", () => {
		for (const open of [false, true]) {
			const changes: unknown[] = [];
			const cleared: string[] = [];
			const account = makeAccount();
			const tree = rowTree(
				{
					account,
					...requiredHandlers,
					onClearSettingsError: (id) => cleared.push(id),
				},
				open,
				changes,
			);
			const trigger = treeNodes(tree).find((n) => n.props["aria-controls"]);
			expect(trigger?.props["aria-expanded"]).toBe(open);
			(trigger?.props.onClick as () => void)();
			expect(changes).toEqual([!open]);
			expect(cleared).toEqual([account.id]);
		}
	});
});

it("keeps priority in identity, lifetime requests in Details, and refresh on the row", () => {
	const html = renderToStaticMarkup(
		<AccountListItem
			account={makeAccount({ priority: 31, requestCount: 1234 })}
			{...requiredHandlers}
		/>,
	);
	const visible = withoutDetailsContent(html);
	expect(visible.match(/Priority /g)).toHaveLength(1);
	expect(visible).not.toContain("1,234 requests");
	expect(html).toContain("1,234 requests");
	// One refresh control, on the row with Pause, Details and More.
	expect(visible).toContain('aria-label="Refresh usage for acc-1"');
	expect(html.match(/aria-label="Refresh usage/g)).toHaveLength(1);
});

it("lays the usage bars out by the usage cell, which holds no controls", () => {
	// The bars switch to one line per window at a container width. Refresh moved
	// from a 48px column in this cell to the action column, so the switch moved
	// from 28rem to 25rem and keeps its place on wide screens.
	const reset = new Date(Date.now() + 3600000).toISOString();
	const account = makeAccount({
		usageWindow: "seven_day",
		usageUtilization: 32,
		usageData: { seven_day: { utilization: 32, resets_at: reset } },
	});
	const html = withoutDetailsContent(
		renderToStaticMarkup(
			<AccountListItem account={account} {...requiredHandlers} />,
		),
	);
	expect(html.match(/@container/g)).toHaveLength(1);
	const cell = html.slice(
		html.lastIndexOf("<div", html.indexOf("xl:col-start-2 xl:row-start-1")),
	);
	expect(cell.slice(0, cell.indexOf(">"))).toContain("@container");
	expect(cell).not.toContain("Refresh usage");
	expect(cell).toContain("@[25rem]:");
	expect(cell).not.toContain("@[28rem]:");
});

it("represents a matching scoped binding inline and preserves unmatched exceptions", () => {
	const reset = new Date(Date.now() + 3600000).toISOString();
	const account = makeAccount({
		usageWindow: "seven_day",
		usageUtilization: 32,
		usageData: {
			seven_day: { utilization: 32, resets_at: reset },
			seven_day_fable: { utilization: 100, resets_at: reset },
		},
		bindingConstraint: {
			window: "seven_day_fable",
			utilization: 100,
			resetAtMs: Date.parse(reset),
			scope: "family",
			modelFamily: "fable",
		},
	});
	const html = withoutDetailsContent(
		renderToStaticMarkup(
			<AccountListItem account={account} {...requiredHandlers} />,
		),
	);
	expect(html).not.toContain('data-testid="binding-constraint"');
	expect(html).toContain("Fable (Weekly)");
	expect(html).toContain("Exhausted");
	expect(html).toContain("limit for this model");
	expect(html).toContain("currently limiting");
});

function rowTree(
	props: Parameters<typeof AccountListItem>[0],
	open: boolean,
	changes: unknown[] = [],
	states: Record<number, unknown> = {},
) {
	const React = require("react");
	const internals =
		React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
	const previous = internals.H;
	let index = 0;
	internals.H = {
		useState: (initial: unknown) => {
			const slot = index++;
			return [
				slot === 1 ? open : slot in states ? states[slot] : initial,
				(value: unknown) => changes.push(value),
			];
		},
		useId: () => "account-details-test",
	};
	try {
		return AccountListItem(props);
	} finally {
		internals.H = previous;
	}
}
function treeNodes(tree: unknown): { props: Record<string, unknown> }[] {
	const nodes: { props: Record<string, unknown> }[] = [];
	function visit(node: unknown) {
		if (!node || typeof node !== "object") return;
		if (Array.isArray(node)) {
			node.forEach(visit);
			return;
		}
		const element = node as { props?: Record<string, unknown> };
		if (element.props) {
			nodes.push(element as { props: Record<string, unknown> });
			visit(element.props.children);
		}
	}
	visit(tree);
	return nodes;
}
it("opens reset confirmation directly without collapsing the account panel", () => {
	const events: unknown[] = [];
	const account = makeAccount({
		provider: "codex",
		bankedResets: {
			tracked: true,
			availableCount: 2,
			applicableCount: 0,
			appliesNow: false,
			soonestExpiresAt: null,
			doesNotExpire: false,
			stale: false,
			observedAt: null,
		},
	});
	const tree = rowTree(
		{
			account,
			...requiredHandlers,
			onUseReset: (selected) => events.push(selected),
		},
		true,
		events,
	);
	const reset = treeNodes(tree).find(
		(n) => n.props.onUseReset && !n.props.compact,
	);
	expect(reset).toBeDefined();
	(reset?.props.onUseReset as () => void)();
	expect(events).toEqual([account]);
});
it("opens public value confirmation and label editing without collapsing Settings", () => {
	const account = makeAccount();
	const events: unknown[] = [];
	const toggle = (selected: Account) => events.push(["toggle", selected]);
	const edit = (selected: Account) => events.push(["edit", selected]);
	const tree = rowTree(
		{
			account,
			...requiredHandlers,
			onPublicValueToggle: toggle,
			onPublicValueEditLabel: edit,
		},
		true,
		events,
	);
	const control = treeNodes(tree).find((n) => n.props.onEditLabel);
	expect(control).toBeDefined();
	(control?.props.onToggle as (account: Account) => void)(account);
	(control?.props.onEditLabel as (account: Account) => void)(account);
	expect(events).toEqual([
		["toggle", account],
		["edit", account],
	]);
});
it("groups usage, routing and settings into named touch-sized tabs", () => {
	const html = renderToStaticMarkup(
		<AccountListItem
			account={makeAccount({ customEndpoint: "https://gateway.example/v1" })}
			{...requiredHandlers}
		/>,
	);
	expect(html).toContain('role="tablist"');
	for (const tab of ["usage", "routing", "settings"])
		expect(html).toContain(`data-tab-content="${tab}"`);
	const triggers = html.match(/<button[^>]*role="tab"[^>]*>/g) ?? [];
	expect(triggers).toHaveLength(3);
	for (const tab of triggers) expect(tab).toContain("min-h-11");
	const usage = html.indexOf('data-tab-content="usage"');
	const routing = html.indexOf('data-tab-content="routing"');
	const settings = html.indexOf('data-tab-content="settings"');
	expect(html.indexOf("requests", usage)).toBeLessThan(routing);
	expect(html.indexOf("custom endpoint", routing)).toBeLessThan(settings);
	expect(html.indexOf("Return after reset", settings)).toBeGreaterThan(
		settings,
	);
});
it("keeps settings errors before the tab content, not inside a single tab", () => {
	const html = renderToStaticMarkup(
		<AccountListItem
			account={makeAccount()}
			{...requiredHandlers}
			settingsError="Setting failed"
		/>,
	);
	expect(html.indexOf('role="alert"')).toBeGreaterThan(
		html.indexOf("<section id="),
	);
	expect(html.indexOf('role="alert"')).toBeLessThan(
		html.indexOf('data-tab-content="usage"'),
	);
});
it("uses unique detail regions for multiple account rows", () => {
	const html = renderClosedMarkup(
		<AccountList
			accounts={[makeAccount(), makeAccount({ id: "acc-2", name: "second" })]}
			{...requiredHandlers}
		/>,
	);
	const ids = [...html.matchAll(/<section id="([^"]+)"/g)].map(
		(match) => match[1],
	);
	expect(ids).toHaveLength(2);
	expect(new Set(ids).size).toBe(2);
});

it("retains a visible exception if a binding observation differs from the quota stack", () => {
	const account = makeAccount({
		usageWindow: "seven_day",
		usageData: { seven_day: { utilization: 32, resets_at: null } },
		bindingConstraint: {
			window: "seven_day",
			utilization: 100,
			resetAtMs: null,
			scope: "account",
			modelFamily: null,
		},
	});
	const visible = withoutDetailsContent(
		renderToStaticMarkup(
			<AccountListItem account={account} {...requiredHandlers} />,
		),
	);
	expect(visible).toContain('data-testid="binding-constraint"');
	expect(visible).toContain("100%");
	expect(visible).toContain("32%");
});

it("names pause controls by account and distinguishes the paused pill icon", () => {
	for (const paused of [false, true]) {
		const html = renderClosedMarkup(
			<AccountListItem
				account={makeAccount({ name: "named-account", paused })}
				{...requiredHandlers}
			/>,
		);
		const label = `${paused ? "Resume" : "Pause"} named-account`;
		expect(html).toContain(`aria-label="${label}"`);
		expect(html).toContain(`title="${label}"`);
		if (paused) {
			expect(html).toContain("lucide-circle-pause");
			const button = html.match(
				/<button[^>]*aria-label="Resume named-account"[^>]*>[\s\S]*?<\/button>/,
			)?.[0];
			expect(button).toContain("lucide-play");
		}
	}
});
