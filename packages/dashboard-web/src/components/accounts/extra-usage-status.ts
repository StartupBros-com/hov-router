/**
 * What a Claude login's row says about extra usage: the setting Anthropic
 * reports, a warning while it reads on, and each hold the router keeps.
 * Pure, so the row and its tests share one source for the copy.
 */
import { formatClockTime } from "@better-ccflare/ui-common";
import type { Account } from "../../api";
import { formatWindowName } from "./rate-limit-helpers";

/** Where the member changes the setting; the router never changes it. */
export const ANTHROPIC_USAGE_SETTINGS_URL = "https://claude.ai/settings/usage";

/** The routing pass that returns a paused login waits this long past its reset. */
const AUTO_RETURN_BUFFER_MS = 1000;

export type ExtraUsageStatusInput = Pick<
	Account,
	| "provider"
	| "autoPauseOnOverageEnabled"
	| "autoFallbackEnabled"
	| "rateLimitReset"
	| "extraUsage"
	| "extraUsageHolds"
	| "extraUsageBilledHold"
>;

export interface ExtraUsageHoldLine {
	key: string;
	/** What is held: one model family, or every model. */
	held: string;
	/** Why the router holds it. */
	why: string;
	/** How the hold ends, as a sentence. */
	ends: string;
}

export interface ExtraUsageStatus {
	state: "on" | "off" | "unknown";
	/** The state with the time of the reading it comes from. */
	stateLine: string;
	/** Shown only while the state reads on. */
	warning: string | null;
	holds: ExtraUsageHoldLine[];
}

type ClockOptions = { locale?: string; timeZone?: string };

const STATE_LABEL = { on: "on", off: "off", unknown: "not known" } as const;

function familyName(family: string): string {
	return family.charAt(0).toUpperCase() + family.slice(1);
}

function joinOr(parts: string[]): string {
	if (parts.length < 2) return parts.join("");
	return `${parts.slice(0, -1).join(", ")} or ${parts[parts.length - 1]}`;
}

function billedHoldLine(
	account: ExtraUsageStatusInput,
	billed: NonNullable<ExtraUsageStatusInput["extraUsageBilledHold"]>,
	now: number,
	clock: ClockOptions,
): ExtraUsageHoldLine {
	const request = billed.family
		? `${/^[aeiou]/i.test(billed.family) ? "an" : "a"} ${familyName(billed.family)} request`
		: "a request";
	const why =
		billed.billedAt === null
			? `Anthropic billed ${request} as extra usage`
			: `Anthropic billed ${request} as extra usage at ${formatClockTime(billed.billedAt, now, clock)}`;

	// Mirrors the routing pass that returns a login paused for extra usage:
	// only with Return after reset on and a reset stored.
	const ways = ["when you resume this login"];
	const resetMs = account.rateLimitReset
		? Date.parse(account.rateLimitReset)
		: Number.NaN;
	if (account.autoFallbackEnabled && Number.isFinite(resetMs)) {
		ways.push(
			resetMs < now - AUTO_RETURN_BUFFER_MS
				? "at its next request (its reset time has passed)"
				: `after ${formatClockTime(resetMs, now, clock)}`,
		);
	}
	ways.push("when you turn the switch off");
	return {
		key: "billed",
		held: "Every model",
		why,
		ends: `Ends ${joinOr(ways)}.`,
	};
}

export function extraUsageStatus(
	account: ExtraUsageStatusInput,
	now: number,
	clock: ClockOptions = {},
): ExtraUsageStatus | null {
	if (account.provider !== "anthropic" || !account.extraUsage) return null;
	const { state, readingAt } = account.extraUsage;
	const switchOn = account.autoPauseOnOverageEnabled === true;

	const stateLine =
		readingAt === null
			? `Extra usage at Anthropic: ${STATE_LABEL[state]}`
			: `Extra usage at Anthropic: ${STATE_LABEL[state]} · read ${formatClockTime(readingAt, now, clock)}`;
	const warning =
		state === "on"
			? `Anthropic bills requests past a spent plan limit as extra usage. ${
					switchOn
						? "The router’s “Don’t use extra usage on this login” switch is on, so it holds this login once it learns a limit is spent."
						: "The router’s “Don’t use extra usage on this login” switch is off."
				}`
			: null;

	const holds: ExtraUsageHoldLine[] = [];
	if (switchOn) {
		if (account.extraUsageBilledHold) {
			holds.push(
				billedHoldLine(account, account.extraUsageBilledHold, now, clock),
			);
		}
		for (const hold of account.extraUsageHolds ?? []) {
			// The list is only as fresh as the last fetch.
			if (hold.resetsAtMs <= now) continue;
			holds.push({
				key: `reading:${hold.windowKey}:${hold.modelFamily ?? "account"}`,
				held:
					hold.scope === "family" && hold.modelFamily
						? familyName(hold.modelFamily)
						: "Every model",
				why: `${formatWindowName(hold.windowKey)} limit spent`,
				ends: `Ends at ${formatClockTime(hold.resetsAtMs, now, clock)} or when you turn the switch off.`,
			});
		}
	}
	return { state, stateLine, warning, holds };
}
