import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { api } from "./api";

// The alert routes moved from /api/insights/alerts to /api/alerts in 7.0.0
// (#1012); the old paths answer 410, so the dashboard must call the new ones.
const descriptors = new Map(
	["fetch", "localStorage", "window"].map((key) => [
		key,
		Object.getOwnPropertyDescriptor(globalThis, key),
	]),
);
const fetchMock = mock(async (_url: unknown, _init?: RequestInit) =>
	Response.json({ alerts: [], unacknowledgedCount: 0, ok: true }),
);
beforeEach(() => {
	const storage = new Map<string, string>();
	for (const [key, value] of [
		["fetch", fetchMock],
		["window", new EventTarget()],
		[
			"localStorage",
			{
				getItem: (key: string) => storage.get(key) ?? null,
				setItem: (key: string, value: string) => storage.set(key, value),
				removeItem: (key: string) => storage.delete(key),
			},
		],
	] as const)
		Object.defineProperty(globalThis, key, {
			configurable: true,
			writable: true,
			value,
		});
	fetchMock.mockClear();
});
afterEach(() => {
	for (const [key, descriptor] of descriptors) {
		if (descriptor) Object.defineProperty(globalThis, key, descriptor);
		else Reflect.deleteProperty(globalThis, key);
	}
});

function called(): Array<[string, string]> {
	return fetchMock.mock.calls.map(([url, init]) => [
		String(url),
		init?.method ?? "GET",
	]);
}

describe("alert requests", () => {
	it("lists alerts from /api/alerts", async () => {
		await api.getAlerts(25);
		expect(called()).toEqual([["/api/alerts?limit=25", "GET"]]);
	});

	it("acknowledges one alert at /api/alerts/:id, with the id encoded", async () => {
		await api.acknowledgeAlert("cache_health:acct/1");
		expect(called()).toEqual([["/api/alerts/cache_health%3Aacct%2F1", "POST"]]);
	});

	it("acknowledges every alert at /api/alerts/acknowledge-all", async () => {
		await api.acknowledgeAllAlerts();
		expect(called()).toEqual([["/api/alerts/acknowledge-all", "POST"]]);
	});
});
