import { expect } from "bun:test";
import {
	QueryClient,
	QueryClientProvider,
	type QueryKey,
} from "@tanstack/react-query";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PAGE_META } from "../lib/page-meta";

export type TestState = "loading" | "error" | "cached" | "empty";
export function renderPage(
	node: ReactNode,
	seed: (client: QueryClient) => void = () => {},
) {
	const client = new QueryClient({
		defaultOptions: { queries: { retry: false, retryOnMount: false } },
	});
	seed(client);
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={client}>{node}</QueryClientProvider>,
		);
	} finally {
		client.clear();
	}
}
export function seedState(
	client: QueryClient,
	queryKey: QueryKey,
	state: TestState,
	data: unknown,
) {
	if (state === "empty" || state === "cached")
		client.setQueryData(queryKey, data);
	if (state === "error" || state === "cached")
		client
			.getQueryCache()
			.build(client, { queryKey })
			.setState({
				status: "error",
				error: new TypeError("Failed to fetch"),
				fetchStatus: "idle",
			});
}
export function expectHeader(html: string, page: keyof typeof PAGE_META) {
	expect(html.match(/<h1\b/g)).toHaveLength(1);
	expect(html).toContain(`>${PAGE_META[page].title}</h1>`);
}
