import { describe, expect, it, mock } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { EmptyState, ErrorState, LoadingState } from "./state";

it("announces loading with its label and visible copy", () => {
	const html = renderToStaticMarkup(<LoadingState label="Loading accounts" />);
	expect(html).toContain('role="status"');
	expect(html).toContain('aria-label="Loading accounts"');
	expect(html.replace(/<[^>]*>/g, "")).toContain("Loading accounts…");
});
it("announces the error title and message as an alert", () => {
	const html = renderToStaticMarkup(
		<ErrorState title="Accounts could not load" message="Connection failed" />,
	);
	expect(html).toContain('role="alert"');
	expect(html).toContain("Accounts could not load");
	expect(html).toContain("Connection failed");
});
it("omits Retry when no retry handler is supplied", () => {
	const html = renderToStaticMarkup(
		<ErrorState title="Accounts could not load" message="Connection failed" />,
	);
	expect(html).not.toContain("<button");
	expect(html).not.toContain("Retry");
});
it("renders a touch-sized Retry and invokes its handler", () => {
	const onRetry = mock(() => {});
	const state = ErrorState({
		title: "Accounts could not load",
		message: "Connection failed",
		onRetry,
	});
	const html = renderToStaticMarkup(state);
	expect(html).toMatch(
		/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Retry<\/button>/,
	);
	const findRetry = (node: unknown): (() => void) | undefined => {
		if (Array.isArray(node)) return node.map(findRetry).find(Boolean);
		if (!node || typeof node !== "object" || !("props" in node))
			return undefined;
		const props = node.props as { onClick?: () => void; children?: unknown };
		return props.onClick ?? findRetry(props.children);
	};
	const click = findRetry(state);
	expect(click).toBeDefined();
	click?.();
	expect(onRetry).toHaveBeenCalledTimes(1);
});
it("renders the empty title, description and action", () => {
	const html = renderToStaticMarkup(
		<EmptyState
			title="No accounts"
			description="Add an account to get started"
			action={<button type="button">Add account</button>}
		/>,
	);
	expect(html).toContain("No accounts");
	expect(html).toContain("Add an account to get started");
	expect(html).toContain(">Add account</button>");
});
describe("state sizes", () => {
	it("keeps the page size as the default look", () => {
		expect(
			renderToStaticMarkup(
				<LoadingState label="Loading accounts" size="page" />,
			),
		).toBe(renderToStaticMarkup(<LoadingState label="Loading accounts" />));
		expect(
			renderToStaticMarkup(
				<ErrorState title="Accounts could not load" message="M" size="page" />,
			),
		).toBe(
			renderToStaticMarkup(
				<ErrorState title="Accounts could not load" message="M" />,
			),
		);
	});
	it("renders inline loading as one muted status line", () => {
		expect(
			renderToStaticMarkup(<LoadingState label="Loading logs" size="inline" />),
		).toBe(
			'<p role="status" aria-label="Loading logs" class="text-sm text-muted-foreground">Loading logs…</p>',
		);
	});
	it("renders an inline error as one destructive alert line with an optional Retry", () => {
		const plain = renderToStaticMarkup(
			<ErrorState
				size="inline"
				title="Logs could not load"
				message="Network error."
			/>,
		);
		expect(plain).toContain('role="alert"');
		expect(plain).toContain("text-destructive");
		expect(plain).not.toContain("<h3");
		expect(plain).not.toContain("<button");
		expect(plain.replace(/<[^>]*>/g, "")).toBe(
			"Logs could not load. Network error.",
		);
		const retry = renderToStaticMarkup(
			<ErrorState
				size="inline"
				title="Logs could not load"
				message="Network error."
				onRetry={() => undefined}
			/>,
		);
		expect(retry).toMatch(
			/<button[^>]*class="[^"]*min-h-11[^"]*"[^>]*>Retry<\/button>/,
		);
	});
	it("renders an inline error without a message as its title alone", () => {
		const html = renderToStaticMarkup(
			<ErrorState
				size="inline"
				title="Routing-attempt summary could not load"
			/>,
		);
		expect(html).toContain('role="alert"');
		expect(html.replace(/<[^>]*>/g, "")).toBe(
			"Routing-attempt summary could not load.",
		);
	});
	it("draws the page-size empty state as a centred dashed box", () => {
		const html = renderToStaticMarkup(
			<EmptyState title="No agents yet" description="Add one to start." />,
		);
		expect(html).toContain(
			'<div class="flex flex-col items-center gap-3 rounded-lg border border-dashed px-8 py-12 text-center">',
		);
		expect(html).toContain("No agents yet");
		expect(html).toContain("Add one to start.");
	});
	it("renders the inline empty state as muted text without a box", () => {
		const html = renderToStaticMarkup(
			<EmptyState
				size="inline"
				title="No logs yet."
				description="Logs appear here as the router writes them."
			/>,
		);
		expect(html).not.toContain("border");
		expect(html).not.toContain("<h3");
		expect(html).toContain("text-sm text-muted-foreground");
		expect(html.replace(/<[^>]*>/g, "")).toBe(
			"No logs yet. Logs appear here as the router writes them.",
		);
	});
});
