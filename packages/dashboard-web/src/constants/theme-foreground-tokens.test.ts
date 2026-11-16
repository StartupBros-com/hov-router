import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";

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

type Rgb = [number, number, number];

function hsl(theme: string, token: string): Rgb {
	const line = theme
		.split("\n")
		.map((l) => l.trim())
		.find((l) => l.startsWith(`${token}:`));
	expect(line).toBeDefined();
	const value = line?.slice(token.length + 1, line.indexOf(";")).trim() ?? "";
	expect(value.startsWith("hsl(")).toBe(true);
	const [h, s, l] = value
		.slice(4, value.indexOf(")"))
		.split(" ")
		.map((part) => Number.parseFloat(part));
	const sat = s / 100;
	const light = l / 100;
	const k = (n: number) => (n + h / 30) % 12;
	const a = sat * Math.min(light, 1 - light);
	const f = (n: number) =>
		light - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
	return [f(0), f(8), f(4)].map((v) => v * 255) as Rgb;
}

/** `fill` at `alpha` over `under`, as `bg-primary/90` paints it. */
function over(fill: Rgb, alpha: number, under: Rgb): Rgb {
	return fill.map((c, i) => c * alpha + under[i] * (1 - alpha)) as Rgb;
}

function luminance(rgb: Rgb): number {
	const lin = (c: number) => {
		const v = c / 255;
		return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * lin(rgb[0]) + 0.7152 * lin(rgb[1]) + 0.0722 * lin(rgb[2]);
}

function contrast(a: Rgb, b: Rgb): number {
	const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
	return (hi + 0.05) / (lo + 0.05);
}

describe("text on the orange fills", () => {
	// Default buttons and badges, the user's message bubble, highlighted select
	// and menu items, and hovered outline and ghost buttons all draw their text
	// in these foreground tokens on the orange --primary / --accent fill.
	const pairs = [
		["--primary", "--primary-foreground"],
		["--accent", "--accent-foreground"],
	] as const;

	it("reaches 4.5:1 on the solid fill in both themes", () => {
		for (const [name, theme] of Object.entries(THEMES))
			for (const [fill, text] of pairs) {
				const ratio = contrast(hsl(theme, text), hsl(theme, fill));
				expect({ name, text, passes: ratio >= 4.5 }).toEqual({
					name,
					text,
					passes: true,
				});
			}
	});

	it("reaches 4.5:1 on the hovered button (90 %) and badge (80 %) fills", () => {
		for (const [name, theme] of Object.entries(THEMES)) {
			const page = hsl(theme, "--background");
			for (const alpha of [0.9, 0.8]) {
				const fill = over(hsl(theme, "--primary"), alpha, page);
				const ratio = contrast(hsl(theme, "--primary-foreground"), fill);
				expect({ name, alpha, passes: ratio >= 4.5 }).toEqual({
					name,
					alpha,
					passes: true,
				});
			}
		}
	});
});
