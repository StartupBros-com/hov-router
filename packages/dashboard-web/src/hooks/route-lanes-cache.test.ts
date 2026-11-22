import { describe, expect, it } from "bun:test";
import { QueryClient } from "@tanstack/react-query";
import { queryKeys } from "../lib/query-keys";
import type { RouteLanes } from "../lib/route-lanes-api";
import { applySavedRouteLanes } from "./queries";

const lanes = (revision: number): RouteLanes => ({
	revision,
	profiles: [],
	lanes: [],
	status: { source: "database", status: "ok", count: 0, revision },
	warnings: [],
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("caching a saved lane set", () => {
	it("is not undone by a read that answers after the save", async () => {
		const client = new QueryClient({
			defaultOptions: { queries: { retry: false } },
		});
		const key = queryKeys.routeLanes();
		client.setQueryData(key, lanes(4));
		let answer: ((value: RouteLanes) => void) | undefined;
		const poll = client
			.fetchQuery({
				queryKey: key,
				queryFn: () =>
					new Promise<RouteLanes>((resolve) => {
						answer = resolve;
					}),
				staleTime: 0,
			})
			.catch(() => undefined);
		await tick();
		expect(answer).toBeDefined();

		await applySavedRouteLanes(client, lanes(5));
		answer?.(lanes(4));
		await poll;
		await tick();

		expect(client.getQueryData<RouteLanes>(key)?.revision).toBe(5);
	});
});
