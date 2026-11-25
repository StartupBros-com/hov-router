import { describe, expect, it } from "bun:test";
import type { AlertEvent } from "@better-ccflare/types";
import {
	ALERT_ATTENTION_WINDOW_MS,
	alertBadgeLabel,
	alertsNeedingAttention,
} from "./alert-attention";

const NOW = 1_800_000_000_000;
const HOUR = 60 * 60 * 1000;

let nextId = 0;
function alert(overrides: Partial<AlertEvent>): AlertEvent {
	nextId += 1;
	return {
		id: `alert-${nextId}`,
		timestamp: NOW - HOUR,
		type: "auth_failure",
		severity: "critical",
		title: "Synthetic alert",
		message: "Made up for a test.",
		value: null,
		threshold: null,
		account: null,
		model: null,
		project: null,
		requestId: null,
		acknowledged: false,
		...overrides,
	};
}

describe("alertsNeedingAttention", () => {
	it("counts unacknowledged warning and critical alerts from the last day", () => {
		const result = alertsNeedingAttention(
			[
				alert({ severity: "critical" }),
				alert({ severity: "warning", timestamp: NOW - 23 * HOUR }),
			],
			NOW,
			200,
		);
		expect(result).toEqual({ count: 2, truncated: false });
	});

	it("never counts info alerts, acknowledged alerts or alerts older than a day", () => {
		const result = alertsNeedingAttention(
			[
				alert({ severity: "info", type: "cache_efficiency_recovered" }),
				alert({ acknowledged: true }),
				alert({ timestamp: NOW - 25 * HOUR }),
			],
			NOW,
			200,
		);
		expect(result).toEqual({ count: 0, truncated: false });
	});

	it("counts an alert exactly at the window edge", () => {
		const result = alertsNeedingAttention(
			[alert({ timestamp: NOW - ALERT_ATTENTION_WINDOW_MS })],
			NOW,
			200,
		);
		expect(result.count).toBe(1);
	});

	it("marks the count truncated when a full page is still inside the window", () => {
		const page = [alert({}), alert({}), alert({ severity: "info" })];
		expect(alertsNeedingAttention(page, NOW, 3)).toEqual({
			count: 2,
			truncated: true,
		});
	});

	it("does not mark a full page truncated once it reaches past the window", () => {
		const page = [alert({}), alert({ timestamp: NOW - 30 * HOUR })];
		expect(alertsNeedingAttention(page, NOW, 2)).toEqual({
			count: 1,
			truncated: false,
		});
	});
});

describe("alertBadgeLabel", () => {
	it("hides the badge when nothing needs attention", () => {
		expect(alertBadgeLabel({ count: 0, truncated: false })).toBeUndefined();
	});

	it("shows the count, with a plus when the list was cut short", () => {
		expect(alertBadgeLabel({ count: 3, truncated: false })).toBe("3");
		expect(alertBadgeLabel({ count: 200, truncated: true })).toBe("200+");
	});
});
