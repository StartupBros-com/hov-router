import { describe, expect, it } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { queryKeys } from "../lib/query-keys";
import { AccountsTab } from "./AccountsTab";

const H1 = '<h1 class="text-2xl font-semibold tracking-tight">Accounts</h1>';
const DESCRIPTION =
	'<p class="text-sm text-muted-foreground">Provider accounts, usage limits and routing settings</p>';

function render(seed: (queryClient: QueryClient) => void = () => undefined) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false, retryOnMount: false } },
	});
	seed(queryClient);
	try {
		return renderToStaticMarkup(
			<QueryClientProvider client={queryClient}>
				<AccountsTab />
			</QueryClientProvider>,
		);
	} finally {
		queryClient.clear();
	}
}

describe("Accounts page header", () => {
	it("stays visible above the loading state, without actions until accounts arrive", () => {
		const html = render();
		expect(html.match(/<h1\b/g)).toHaveLength(1);
		expect(html).toContain(H1 + DESCRIPTION);
		expect(html.indexOf(H1)).toBeLessThan(html.indexOf('role="status"'));
		expect(html).not.toContain("Add Account");
	});

	it("renders a load error below the header", () => {
		const html = render((queryClient) => {
			queryClient
				.getQueryCache()
				.build(queryClient, { queryKey: queryKeys.accounts() })
				.setState({
					status: "error",
					error: new Error("Accounts fetch failed"),
					fetchStatus: "idle",
				});
		});
		expect(html.match(/<h1\b/g)).toHaveLength(1);
		expect(html.indexOf(H1)).toBeLessThan(html.indexOf('role="alert"'));
		expect(html).toContain("Accounts could not load");
	});

	it("keeps the loaded header's classes, description and actions row", () => {
		const html = render((queryClient) => {
			queryClient.setQueryData(queryKeys.accounts(), []);
		});
		expect(html.match(/<h1\b/g)).toHaveLength(1);
		expect(html).toContain(
			`<div class="flex flex-wrap items-center justify-between gap-4"><div>${H1}${DESCRIPTION}</div><div class="flex min-w-0 flex-wrap items-center gap-3">`,
		);
		expect(html).toContain("Add Account");
	});
});
