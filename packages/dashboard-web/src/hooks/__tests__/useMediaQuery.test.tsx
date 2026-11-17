import { afterEach, describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { useMediaQuery } from "../useMediaQuery";

const g = globalThis as unknown as { window?: unknown };
const original = g.window;

function Probe() {
	return <span>{String(useMediaQuery("(min-width: 1024px)"))}</span>;
}

afterEach(() => {
	g.window = original;
});

describe("useMediaQuery", () => {
	it("is false without matchMedia", () => {
		g.window = undefined;
		expect(renderToStaticMarkup(<Probe />)).toContain("false");
	});

	it("reads the current match on the first render", () => {
		g.window = { matchMedia: () => ({ matches: true }) };
		expect(renderToStaticMarkup(<Probe />)).toContain("true");
	});
});
