import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { ApiKeysTab } from "./ApiKeysTab";
import { renderPage } from "./page-state-test-helpers";

const REASON_TITLE = 'title="First API key must remain admin"';
const VISIBLE =
	/<span class="text-xs text-muted-foreground">First key stays admin<\/span>/;

function key(id: string, role: "admin" | "api-only", createdAt: string) {
	return {
		id,
		name: `${id} name`,
		prefixLast8: `${id}0000`.slice(0, 8),
		createdAt,
		lastUsed: null,
		usageCount: 2,
		isActive: true,
		role,
	};
}

function render(active: number) {
	return renderPage(<ApiKeysTab />, (client) => {
		client.setQueryData(["api-keys"], {
			success: true,
			count: 2,
			data: [
				key("first", "admin", "2026-01-01"),
				key("second", "admin", "2026-02-01"),
			],
		});
		client.setQueryData(["api-keys-stats"], {
			data: { total: 2, active, inactive: 2 - active },
		});
	});
}

const realLocalStorage = Object.getOwnPropertyDescriptor(
	globalThis,
	"localStorage",
);
beforeAll(() => {
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		value: { getItem: () => null, setItem: () => {}, removeItem: () => {} },
	});
});
afterAll(() => {
	if (realLocalStorage)
		Object.defineProperty(globalThis, "localStorage", realLocalStorage);
	else delete (globalThis as { localStorage?: unknown }).localStorage;
});

describe("API Keys visible state", () => {
	it("shows the read-only reason as text on exactly the rows that carry the title", () => {
		const html = render(2);
		const titles = html.split(REASON_TITLE).length - 1;
		const visible = html.split("First key stays admin").length - 1;
		// Only the oldest key is read-only; the second key has an editable menu.
		expect(titles).toBe(1);
		expect(visible).toBe(titles);
		expect(html).toMatch(VISIBLE);
	});
});
