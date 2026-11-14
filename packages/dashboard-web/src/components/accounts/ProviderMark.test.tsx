import { expect, it } from "bun:test";
import { PROVIDER_NAMES } from "@better-ccflare/types";
import { renderToStaticMarkup } from "react-dom/server";
import { ProviderMark, providerMarkKey } from "./ProviderMark";

it("renders all 19 providers decoratively in currentColor", () => {
	const providers = Object.values(PROVIDER_NAMES);
	expect(providers).toHaveLength(19);
	for (const provider of providers) {
		const html = renderToStaticMarkup(<ProviderMark provider={provider} />);
		expect(html).toContain('aria-hidden="true"');
		expect(html).toContain("currentColor");
		expect(html).toContain("h-4 w-4 shrink-0 text-muted-foreground");
		expect(html).not.toContain("<title");
		// No brand colours: every fill and stroke comes from currentColor.
		expect(html).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(|url\(#/i);
		for (const paint of html.match(/(?:fill|stroke)="[^"]*"/g) ?? [])
			expect(paint).toMatch(/="(currentColor|none)"$/);
	}
});

it("identifies Codex as OpenAI and keeps compatible, NanoGPT and unknown marks generic", () => {
	expect(providerMarkKey("codex")).toBe("openai");
	expect(renderToStaticMarkup(<ProviderMark provider="codex" />)).toContain(
		'data-provider-mark="openai"',
	);
	for (const provider of [
		"openai-compatible",
		"anthropic-compatible",
		"nanogpt",
		"unknown",
		"toString",
	]) {
		expect(providerMarkKey(provider)).toBeNull();
		expect(
			renderToStaticMarkup(<ProviderMark provider={provider} />),
		).toContain('data-provider-mark="generic"');
	}
});
