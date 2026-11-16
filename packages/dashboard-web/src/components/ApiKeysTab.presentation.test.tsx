import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ApiKeysTab } from "./ApiKeysTab";
import { renderPage } from "./page-state-test-helpers";

type Role = "admin" | "api-only";
function key(
	id: string,
	role: Role,
	isActive: boolean,
	createdAt: string,
	prefixLast8: string,
) {
	return {
		id,
		name: `${id} name`,
		prefixLast8,
		createdAt,
		lastUsed: null,
		usageCount: 2,
		isActive,
		role,
	};
}

function render(firstRole: Role) {
	return renderPage(<ApiKeysTab />, (client) => {
		client.setQueryData(["api-keys"], {
			success: true,
			count: 3,
			data: [
				key("first", firstRole, true, "2026-01-01", "aaaa1111"),
				key("second", "admin", true, "2026-02-01", "bbbb2222"),
				key("third", "api-only", false, "2026-03-01", "cccc3333"),
			],
		});
		client.setQueryData(["api-keys-stats"], {
			data: { total: 3, active: 2, inactive: 1 },
		});
	});
}

/** The row's markup between its name heading and the next row's. */
function row(html: string, name: string) {
	const start = html.indexOf(`>${name}</h3>`);
	expect(start).toBeGreaterThan(-1);
	const next = html.indexOf('<h3 class="font-medium break-all"', start + 1);
	return html.slice(start, next === -1 ? undefined : next);
}

function tagWith(html: string, needle: string) {
	const index = html.indexOf(needle);
	expect(index).toBeGreaterThan(-1);
	const start = html.lastIndexOf("<", index);
	return html.slice(start, html.indexOf(">", index) + 1);
}

// A row past the first asks the api client for the stored key, which reads localStorage.
const realLocalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage",
);
beforeAll(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: {
			getItem: () => null,
			setItem: () => {},
			removeItem: () => {},
		},
	});
});
afterAll(() => {
	if (realLocalStorage)
		Object.defineProperty(globalThis, "localStorage", realLocalStorage);
	else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("API Keys presentation", () => {
	let html = "";
	beforeAll(() => {
		html = render("admin");
	});

	it("shows status as a success or neutral pill", () => {
		expect(row(html, "second name")).toMatch(
			/data-tone="success"[^>]*>Active<\/span>/,
		);
		expect(row(html, "third name")).toMatch(
			/data-tone="neutral"[^>]*>Disabled<\/span>/,
		);
	});

	it("shows the editable role pill inside a menu button", () => {
		const second = row(html, "second name");
		expect(second).toMatch(
			/<button[^>]*aria-haspopup="menu"[^>]*><span[^>]*data-tone="warning"[^>]*>Admin<\/span>/,
		);
		const third = row(html, "third name");
		expect(third).toMatch(
			/<button[^>]*aria-haspopup="menu"[^>]*><span[^>]*data-tone="info"[^>]*>API-only<\/span>/,
		);
	});

	it("shows the read-only role pill with its reason as a title", () => {
		expect(row(html, "first name")).toMatch(
			/<span[^>]*data-tone="warning"[^>]*title="First API key must remain admin"[^>]*>Admin<\/span>|<span[^>]*title="First API key must remain admin"[^>]*data-tone="warning"[^>]*>Admin<\/span>/,
		);
		expect(row(html, "first name")).not.toContain('aria-haspopup="menu"');
		expect(row(render("api-only"), "first name")).toMatch(
			/data-tone="info"[^>]*>API-only<\/span>|title="First API key must remain admin"[^>]*data-tone="info"/,
		);
	});

	it("draws the three stat tiles with Active in the success colour", () => {
		for (const [label, value, tone] of [
			["Total Keys", "3", "text-2xl"],
			["Active Keys", "2", "text-success"],
			["Inactive Keys", "1", "text-muted-foreground"],
		])
			expect(html).toMatch(
				new RegExp(
					`<p class="text-sm text-muted-foreground">${label}</p><p class="[^"]*${tone}[^"]*">${value}</p>`,
				),
			);
	});

	it("gives each row copy button its name and a 44 px size", () => {
		for (const last8 of ["aaaa1111", "bbbb2222", "cccc3333"]) {
			const tag = tagWith(html, `aria-label="Copy key ending ${last8}"`);
			expect(tag).toContain("h-11 w-11");
			expect(tag).toContain(`title="Copy key ending ${last8}"`);
		}
	});

	it("makes toggle and delete 44 px icon buttons that keep their names", () => {
		for (const label of [
			"Disable second name",
			"Enable third name",
			"Delete second name",
		]) {
			const tag = tagWith(html, `aria-label="${label}"`);
			expect(tag).toContain("h-11 w-11");
		}
	});

	it("holds no raw palette class", () => {
		expect(html).not.toMatch(
			/\b(?:bg|text|border)-(?:amber|yellow|green|blue|gray)-\d{2,3}\b/,
		);
	});
});
