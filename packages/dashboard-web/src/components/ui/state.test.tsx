import { expect, it, mock } from "bun:test";
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
