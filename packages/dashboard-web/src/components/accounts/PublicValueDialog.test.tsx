import { describe, expect, it } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { Dialog } from "../ui/dialog";
import { PublicValueForm } from "./PublicValueDialog";

function render(props: Partial<Parameters<typeof PublicValueForm>[0]> = {}) {
	return renderToStaticMarkup(
		<Dialog open>
			<PublicValueForm
				accountName="my-account"
				initialLabel=""
				provider="anthropic"
				initialPlan={null}
				onClose={() => {}}
				onSave={() => {}}
				{...props}
			/>
		</Dialog>,
	);
}

describe("PublicValueForm", () => {
	it("explains the label is public and must not be the account name", () => {
		const html = render();
		expect(html).toContain("shown publicly on the House of Vibe site");
		expect(html).toContain("must not");
		expect(html).toContain("be the account name");
	});

	it("prefills the stored label and leaves it empty when none", () => {
		expect(render({ initialLabel: "Max #1" })).toContain('value="Max #1"');
		expect(render()).toContain('value=""');
	});

	it("surfaces the server error message", () => {
		const html = render({ error: "label must not contain the account name" });
		expect(html).toContain("label must not contain the account name");
		expect(html).toContain('role="alert"');
		expect(render()).not.toContain('role="alert"');
	});

	it("lists Not set and only the account provider's plans with their monthly price", () => {
		const claude = render({ provider: "anthropic" });
		expect(claude).toContain('<option value="" selected="">Not set</option>');
		expect(claude).toContain("Claude Pro ($20/month)");
		expect(claude).toContain("Claude Max ($100/month)");
		expect(claude).toContain("Claude Ultra ($200/month)");
		expect(claude).not.toContain("ChatGPT");
		const codex = render({ provider: "codex" });
		expect(codex).toContain("ChatGPT Pro 100 ($100/month)");
		expect(codex).toContain("ChatGPT Pro 200 ($200/month)");
		expect(codex).toContain("ChatGPT Pro 500 ($500/month)");
		expect(codex).not.toMatch(/Claude \w+ \(\$/);
		const other = render({ provider: "zai" });
		expect(other).toContain("Not set");
		expect(other).not.toContain("/month)");
	});

	it("preselects the stored plan and falls back to Not set for none or a foreign key", () => {
		const stored = render({ initialPlan: "claude-max" });
		expect(stored).toMatch(/<option value="claude-max" selected="">/);
		expect(render()).toMatch(/<option value="" selected="">Not set/);
		expect(render({ initialPlan: "chatgpt-pro-200" })).toMatch(
			/<option value="" selected="">Not set/,
		);
	});
});
