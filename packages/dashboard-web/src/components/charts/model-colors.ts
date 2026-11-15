import { getModelShortName } from "@better-ccflare/core/models";
import { CHART_COLORS, COLORS } from "../../constants";

export const MODEL_COLORS: Record<string, string> = {
	"claude-3.5-sonnet": COLORS.purple,
	"claude-3.5-haiku": COLORS.success,
	"claude-3-opus": COLORS.blue,
	"claude-opus-4": COLORS.pink,
	"claude-opus-4.1": COLORS.indigo,
	"claude-sonnet-4": COLORS.cyan,
	"claude-sonnet-4.5": COLORS.purple,
};

export function getModelColor(model: string, index?: number): string {
	const shortName = getModelShortName(model);
	if (MODEL_COLORS[shortName]) return MODEL_COLORS[shortName];
	if (MODEL_COLORS[model]) return MODEL_COLORS[model];

	for (const [key, color] of Object.entries(MODEL_COLORS)) {
		if (model.includes(key) || key.includes(model)) return color;
	}

	return index === undefined
		? COLORS.primary
		: CHART_COLORS[index % CHART_COLORS.length];
}
