import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import {
	CHART_COLORS,
	CHART_PROPS,
	CHART_TOOLTIP_STYLE,
	COLORS,
} from "@better-ccflare/ui-constants";

const css = readFileSync(
	new URL("../../styles/globals.css", import.meta.url),
	"utf8",
);

/** The declarations inside the first `<selector> {` block. */
function block(selector: string): string {
	const start = css.indexOf(`${selector} {`);
	expect(start).toBeGreaterThanOrEqual(0);
	return css.slice(start, css.indexOf("\n}", start));
}

const THEMES = { light: block(":root"), dark: block(".dark") };

function declared(theme: string, token: string): string | undefined {
	const line = theme
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.startsWith(`${token}:`));
	return line?.slice(token.length + 1, line.lastIndexOf(";")).trim();
}

function tokenOf(value: string): string {
	expect(value.startsWith("var(--")).toBe(true);
	expect(value.endsWith(")")).toBe(true);
	return value.slice(4, -1);
}

function hexToRgb(hex: string): [number, number, number] {
	expect(hex).toHaveLength(7);
	return [1, 3, 5].map((i) => Number.parseInt(hex.slice(i, i + 2), 16)) as [
		number,
		number,
		number,
	];
}

function hslToRgb(hsl: string): [number, number, number] {
	const [h, s, l] = hsl
		.slice(hsl.indexOf("(") + 1, hsl.indexOf(")"))
		.split(" ")
		.map((part) => Number.parseFloat(part));
	const sat = s / 100;
	const light = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sat * Math.min(light, 1 - light);
	const f = (n: number) =>
		light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)].map((v) => Math.round(v * 255)) as [
		number,
		number,
		number,
	];
}

function luminance([r, g, b]: [number, number, number]): number {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

function contrast(a: [number, number, number], b: [number, number, number]) {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("chart colour tokens", () => {
	it("keeps COLORS' keys and order, adding the two cost colours at the end", () => {
		expect(Object.keys(COLORS)).toEqual([
			"primary",
			"success",
			"warning",
			"error",
			"blue",
			"purple",
			"pink",
			"indigo",
			"cyan",
			"teal",
			"orange",
		]);
	});

	it("keeps CHART_COLORS' length and order", () => {
		expect(CHART_COLORS).toEqual([
			COLORS.primary,
			COLORS.blue,
			COLORS.purple,
			COLORS.pink,
			COLORS.success,
		]);
	});

	it("points every colour at a chart token defined in both themes", () => {
		for (const [key, value] of Object.entries(COLORS)) {
			const token = tokenOf(value);
			expect(token).toBe(`--chart-${key}`);
			for (const theme of Object.values(THEMES))
				expect(declared(theme, token)).toBeDefined();
		}
	});

	it("gives every series at least 3:1 against the card in both themes", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			const card = hslToRgb(declared(theme, "--card") ?? "");
			for (const value of Object.values(COLORS)) {
				const hex = declared(theme, tokenOf(value)) ?? "";
				const ratio = contrast(hexToRgb(hex), card);
				expect({ name, value, ratio: ratio >= 3 }).toEqual({
					name,
					value,
					ratio: true,
				});
			}
		}
	});

	it("draws grid and axes from tokens defined in both themes", () => {
		expect(CHART_PROPS.strokeDasharray).toBe("3 3");
		expect(typeof CHART_PROPS.gridClassName).toBe("string");
		for (const value of [
			CHART_PROPS.gridStroke,
			CHART_PROPS.axisStroke,
			CHART_PROPS.cursorStroke,
			CHART_PROPS.cursorFill,
			CHART_PROPS.surfaceStroke,
		]) {
			const token = tokenOf(value);
			for (const theme of Object.values(THEMES))
				expect(declared(theme, token)).toBeDefined();
		}
	});

	it("gives at most one custom property per theme a color-mix value", () => {
		// The production CSS build writes an @supports copy of the color-mix for
		// the first such custom property in a rule only; each later one keeps just
		// its fallback, the unmixed colour. A second one drew every chart grid in
		// full foreground (built dist, --chart-grid:var(--foreground)).
		for (const theme of Object.values(THEMES)) {
			const mixed = theme
				.split("\n")
				.map((l) => l.trim())
				.filter((l) => l.startsWith("--") && l.includes("color-mix("));
			expect(mixed.length).toBeLessThanOrEqual(1);
		}
	});

	it("keeps every tooltip style and draws each from theme colours", () => {
		expect(Object.keys(CHART_TOOLTIP_STYLE)).toEqual([
			"default",
			"success",
			"dark",
		]);
		for (const style of Object.values(CHART_TOOLTIP_STYLE)) {
			for (const value of Object.values(style)) {
				expect(value).not.toContain("#");
				expect(value).not.toContain("rgb");
				const token = value.slice(value.indexOf("var(--") + 4, -1);
				expect(declared(THEMES.light, token)).toBeDefined();
				if (token !== "--radius")
					expect(declared(THEMES.dark, token)).toBeDefined();
			}
			expect(style.backgroundColor).toBe("var(--popover)");
			expect(style.color).toBe("var(--popover-foreground)");
		}
	});
});
