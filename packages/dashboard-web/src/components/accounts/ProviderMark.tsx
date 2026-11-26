import type { ProviderName } from "@hov-router/types";
import { Plug } from "lucide-react";
import { cn } from "../../lib/utils";
import { PROVIDER_MARK_DATA, type ProviderMarkKey } from "./provider-mark-data";

const PROVIDER_MARKS: Record<ProviderName, ProviderMarkKey | null> = {
	anthropic: "anthropic",
	"claude-console-api": "anthropic",
	codex: "openai",
	zai: "zai",
	minimax: "minimax",
	deepseek: "deepseek",
	openrouter: "openrouter",
	qwen: "qwen",
	"alibaba-coding-plan": "alibabacloud",
	ollama: "ollama",
	"ollama-cloud": "ollama",
	meta: "meta",
	"vertex-ai": "vertexai",
	bedrock: "bedrock",
	xai: "xai",
	kilo: "kilo",
	nanogpt: null,
	"anthropic-compatible": null,
	"openai-compatible": null,
};

export function providerMarkKey(provider: string): ProviderMarkKey | null {
	return Object.hasOwn(PROVIDER_MARKS, provider)
		? PROVIDER_MARKS[provider as ProviderName]
		: null;
}

export function ProviderMark({
	provider,
	className,
}: {
	provider: string;
	className?: string;
}) {
	const key = providerMarkKey(provider);
	const classes = cn("h-4 w-4 shrink-0 text-muted-foreground", className);
	if (key === null)
		return (
			<Plug
				className={classes}
				aria-hidden="true"
				data-provider-mark="generic"
			/>
		);
	return (
		<svg
			viewBox="0 0 24 24"
			fill="currentColor"
			fillRule="evenodd"
			aria-hidden="true"
			focusable="false"
			data-provider-mark={key}
			className={classes}
		>
			{PROVIDER_MARK_DATA[key].paths.map((path) => (
				<path key={path} d={path} />
			))}
		</svg>
	);
}
