import { describe, expect, it } from "bun:test";
import type { Agent } from "@hov-router/types";
import { renderToStaticMarkup } from "react-dom/server";
import { renderPage } from "../page-state-test-helpers";
import { AgentCard } from "./AgentCard";
import { AgentColorSwatches } from "./AgentEditDialog";
import { AGENT_COLOR_NAMES, agentColorClasses } from "./agent-colors";

function agent(overrides: Partial<Agent> = {}): Agent {
	return {
		id: "reviewer",
		name: "Reviewer",
		description: "Reviews code",
		color: "blue",
		model: null,
		systemPrompt: "",
		source: "global",
		filePath: "/tmp/reviewer.md",
		tools: [],
		...overrides,
	} as Agent;
}

const render = (a: Agent) => renderPage(<AgentCard agent={a} />);

function tagWith(html: string, needle: string) {
	const index = html.indexOf(needle);
	expect(index).toBeGreaterThan(-1);
	const start = html.lastIndexOf("<", index);
	return html.slice(start, html.indexOf(">", index) + 1);
}

describe("AgentCard presentation", () => {
	it("draws the palette classes of the colour it is given", () => {
		const html = render(agent({ color: "blue" }));
		const blue = agentColorClasses("blue");
		expect(html).toContain(blue.border);
		expect(html).toContain(blue.bg);
		expect(html).toContain(blue.icon);
		expect(html).not.toContain(agentColorClasses("gray").border);
	});

	it("draws the gray classes for an unknown colour", () => {
		const html = render(agent({ color: "chartreuse" }));
		const gray = agentColorClasses("gray");
		expect(html).toContain(gray.border);
		expect(html).toContain(gray.bg);
		expect(html).toContain(gray.icon);
	});

	for (const [modelSource, text, tone] of [
		["frontmatter", "Default", "neutral"],
		["inherit", "Inherited", "neutral"],
		["preference", "Override", "primary"],
	] as const) {
		it(`shows ${text} as a ${tone} status pill`, () => {
			const html = render(agent({ modelSource }));
			expect(html).toMatch(
				new RegExp(`<span[^>]*data-tone="${tone}"[^>]*>${text}</span>`),
			);
		});
	}

	it("shows Premium as a secondary pill for an opus model", () => {
		const html = render(
			agent({
				model: "claude-opus-4-1" as Agent["model"],
				modelSource: "frontmatter",
			}),
		);
		expect(html).toMatch(
			/<span[^>]*data-tone="secondary"[^>]*>.*Premium<\/span>/,
		);
	});

	it("keeps the location as a Badge, not a status pill", () => {
		const html = render(agent());
		expect(html).toMatch(
			/<div class="[^"]*text-xs[^"]*gap-1[^"]*">.*Global<\/div>/,
		);
		expect(html).not.toMatch(
			/data-tone="[a-z]+"[^>]*>(<svg[^>]*><\/svg>)?Global/,
		);
	});

	it("hides the decorative Sparkles icon from assistive tech", () => {
		const html = render(agent({ model: "claude-opus-4-1" as Agent["model"] }));
		expect(tagWith(html, "lucide-sparkles")).toContain('aria-hidden="true"');
		expect(tagWith(html, "lucide-sparkles")).toContain("text-(--warning)");
		expect(html).not.toContain("text-yellow-500");
	});

	it("sizes the title text-base", () => {
		const html = render(agent());
		expect(html).toMatch(
			/<[a-z0-9]+ class="[^"]*\btext-base font-semibold[^"]*">Reviewer/,
		);
		expect(html).not.toContain("text-lg font-semibold");
	});

	it("makes the edit button a 44 px icon target that keeps its name", () => {
		const tag = tagWith(render(agent()), 'aria-label="Edit Reviewer"');
		expect(tag).toContain("h-11 w-11");
		expect(tag).not.toContain("opacity-0");
	});
});

describe("AgentColorSwatches", () => {
	const html = renderToStaticMarkup(
		<AgentColorSwatches color="green" onColorChange={() => {}} />,
	);

	it("names every swatch and marks only the selected one pressed", () => {
		for (const name of AGENT_COLOR_NAMES) {
			const label = name[0].toUpperCase() + name.slice(1);
			const tag = tagWith(html, `aria-label="${label}"`);
			expect(tag).toContain(
				name === "green" ? 'aria-pressed="true"' : 'aria-pressed="false"',
			);
			expect(tag).toContain('type="button"');
		}
		expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
	});

	it("keeps each swatch 48 px tall and at least 44 px wide, with its palette dot", () => {
		expect(html.match(/relative h-12 min-w-11 /g)).toHaveLength(
			AGENT_COLOR_NAMES.length,
		);
		for (const name of AGENT_COLOR_NAMES)
			expect(html).toContain(agentColorClasses(name).swatch);
	});

	it("calls back with the colour that was pressed", () => {
		const picked: string[] = [];
		const tree = AgentColorSwatches({
			color: "green",
			onColorChange: (c: string) => picked.push(c),
		});
		const buttons: Array<{
			props: { onClick: () => void; "aria-label": string };
		}> = [];
		const walk = (node: unknown) => {
			if (!node || typeof node !== "object") return;
			const el = node as { type?: unknown; props?: Record<string, unknown> };
			if (el.type === "button") buttons.push(el as never);
			const children = el.props?.children;
			for (const child of Array.isArray(children)
				? children.flat(5)
				: [children])
				walk(child);
		};
		walk(tree);
		expect(buttons).toHaveLength(AGENT_COLOR_NAMES.length);
		buttons[1].props.onClick();
		expect(picked).toEqual(["blue"]);
	});
});
