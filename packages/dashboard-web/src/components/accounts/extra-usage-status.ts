/**
 * What a Claude login's row says about extra usage: the setting Anthropic
 * reports, a warning while it reads on, and each hold the router keeps.
 * The collapsed row shows only a pill while the state reads on and each
 * hold's short cue; Details > Settings shows the rest.
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
	/** The usage window a reading hold is for; null for a billed hold. */
	windowKey: string | null;
	/**
	 * The hold in a few words for the collapsed row, or null when the row
	 * already says it: a billed hold always comes with an overage pause, and a
	 * whole-login hold that lasts at least as long covers any other hold.
	 */
	cue: string | null;
}

export interface ExtraUsageStatus {
	state: "on" | "off" | "unknown";
	/** The state with the time of the reading it comes from, as a sentence. */
	stateLine: string;
	/** Shown only while the state reads on; the switch sits beside it. */
	warning: string | null;
	holds: ExtraUsageHoldLine[];
}

type ClockOptions = { locale?: string; timeZone?: string };

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
		windowKey: null,
		cue: null,
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

	const readAt =
		readingAt === null ? null : formatClockTime(readingAt, now, clock);
	const stateLine =
		state === "unknown"
			? readAt === null
				? "Extra usage at Anthropic is not known."
				: `Extra usage at Anthropic is not known (last reading ${readAt}).`
			: readAt === null
				? `Extra usage is ${state} at Anthropic.`
				: `Extra usage is ${state} at Anthropic as of ${readAt}.`;
	const warning =
		state === "on"
			? "Anthropic bills this login’s requests past a spent plan limit."
			: null;

	const holds: ExtraUsageHoldLine[] = [];
	if (switchOn) {
		if (account.extraUsageBilledHold) {
			holds.push(
				billedHoldLine(account, account.extraUsageBilledHold, now, clock),
			);
		}
		// The list is only as fresh as the last fetch.
		const live = (account.extraUsageHolds ?? []).filter(
			(hold) => hold.resetsAtMs > now,
		);
		// The whole-login hold that ends last; the row needs no other cue for
		// the time it covers.
		let longest: (typeof live)[number] | null = null;
		for (const hold of live) {
			if (
				hold.scope === "account" &&
				(longest === null || hold.resetsAtMs > longest.resetsAtMs)
			)
				longest = hold;
		}
		for (const hold of live) {
			const covered =
				longest !== null &&
				hold !== longest &&
				hold.resetsAtMs <= longest.resetsAtMs;
			const family =
				hold.scope === "family" && hold.modelFamily
					? familyName(hold.modelFamily)
					: null;
			const until = formatClockTime(hold.resetsAtMs, now, clock);
			holds.push({
				key: `reading:${hold.windowKey}:${hold.modelFamily ?? "account"}`,
				held: family ?? "Every model",
				why: `${formatWindowName(hold.windowKey)} limit spent`,
				ends: `Ends at ${until} or when you turn the switch off.`,
				windowKey: hold.windowKey,
				// A stored hold outlives a failed reading, so the row's usage bars
				// cannot be relied on to show it.
				cue: covered ? null : `${family ?? "All models"} held until ${until}`,
			});
		}
	}
	return { state, stateLine, warning, holds };
}
