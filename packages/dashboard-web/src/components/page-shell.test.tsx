import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { lazy } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { LazyPage, PageLoading, RoutePageHeader } from "./page-shell";

const H1 = '<h1 class="text-2xl font-semibold tracking-tight">';
const NeverLoads = lazy(
	() => new Promise<{ default: () => null }>(() => undefined),
);

describe("page shell", () => {
	it("shows a lazy page's header and loading state while its chunk loads", () => {
		for (const [page, title] of [
			["analytics", "Analytics"],
			["usageHistory", "Usage History"],
			["windowValue", "Window Value"],
		] as const) {
			const html = renderToStaticMarkup(
				<LazyPage page={page}>
					<NeverLoads />
				</LazyPage>,
			);
			expect(html).toContain(`${H1}${title}</h1>`);
			expect(html.indexOf("<h1")).toBeLessThan(html.indexOf('role="status"'));
			expect(html.replace(/<[^>]*>/g, "")).toContain(
				`Loading ${title.toLowerCase()}…`,
			);
		}
	});

	it("renders the loading page as the header above a page-size loading state", () => {
		const html = renderToStaticMarkup(<PageLoading page="analytics" />);
		expect(html.startsWith('<div class="space-y-4">')).toBe(true);
		expect(html).toContain("Usage patterns and trends over time");
		expect(html).toContain('aria-label="Loading analytics"');
		expect(html).toContain("animate-pulse");
	});

	it("titles a route's header from page meta and keeps its actions", () => {
		const html = renderToStaticMarkup(
			<RoutePageHeader
				page="keys"
				actions={<button type="button">Generate API Key</button>}
			/>,
		);
		expect(html).toContain(`${H1}API Keys</h1>`);
		expect(html).toContain("Generate and manage API keys for authentication");
		expect(html).toContain(">Generate API Key</button>");
	});
});

describe("App page chrome", () => {
	const app = readFileSync(join(import.meta.dir, "../App.tsx"), "utf8");

	it("sends the removed Insights page to Alerts", () => {
		expect(app).toContain('path="/insights"');
		expect(app).toContain("<Navigate to={PAGE_META.alerts.path} replace />");
	});

	it("wraps every lazy route in LazyPage instead of its own skeleton", () => {
		expect(app).not.toContain("<Suspense");
		expect(app).not.toContain("LoadingSkeleton");
		expect(app.match(/<LazyPage page="/g)).toHaveLength(3);
	});

	it("leaves no gradient title anywhere in the dashboard", () => {
		const token = ["gradient", "text"].join("-");
		const root = join(import.meta.dir, "../..");
		const hits = (
			readdirSync(root, { recursive: true, encoding: "utf8" }) as string[]
		)
			.filter(
				(path) =>
					!path
						.split(/[\\/]/)
						.some((part) => ["node_modules", "dist"].includes(part)) &&
					/\.(tsx?|css|html)$/.test(path),
			)
			.filter((path) => readFileSync(join(root, path), "utf8").includes(token));
		expect(hits).toEqual([]);
	});
});
