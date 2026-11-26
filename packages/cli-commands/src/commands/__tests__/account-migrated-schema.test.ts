import { expect, it } from "bun:test";
import type { Config } from "@hov-router/config";
import { DatabaseOperations } from "@hov-router/database";
import type { PromptAdapter } from "../../prompts/adapter";
import { type AddAccountOptionsWithAdapter, addAccount } from "../account";

for (const mode of [
	"nanogpt",
	"kilo",
	"alibaba-coding-plan",
	"openrouter",
	"zai",
	"openai-compatible",
	"anthropic-compatible",
] as const) {
	it(`creates ${mode} against the migrated schema`, async () => {
		const db = new DatabaseOperations(":memory:", { walMode: false });
		const adapter: PromptAdapter = {
			input: async () => "test-api-key-123456789",
			confirm: async () => false,
			select: async <T extends string | number>(
				_question: string,
				choices: Array<{ label: string; value: T }>,
			) => {
				const choice = choices.find((entry) => entry.value === "no");
				if (!choice) throw new Error("Unexpected prompt");
				return choice.value;
			},
		};
		try {
			const options: AddAccountOptionsWithAdapter = {
				name: `test-${mode}`,
				mode,
				priority: 0,
				customEndpoint: "https://example.invalid/v1",
				modelMappings: { opus: ["primary", "backup"] },
				adapter,
			};
			const created = await addAccount(db, {} as Config, options);
			const account = await db.getAccount(created.id);
			expect(account?.name).toBe(options.name);
			expect(JSON.parse(account?.model_mappings ?? "null")).toEqual(
				options.modelMappings,
			);
		} finally {
			await db.close();
		}
	});
}
