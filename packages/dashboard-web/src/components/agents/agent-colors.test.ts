import { describe, expect, it } from "bun:test";
import {
	AGENT_COLOR_CLASSES,
	AGENT_COLOR_NAMES,
	agentColorClasses,
} from "./agent-colors";

const TODAY = {
	gray: {
		border: "border-gray-300 dark:border-gray-700",
		bg: "bg-gray-50 dark:bg-gray-900/50",
		icon: "text-gray-600 dark:text-gray-400",
		swatch: "bg-gray-500",
	},
	blue: {
		border: "border-blue-300 dark:border-blue-700",
		bg: "bg-blue-50 dark:bg-blue-900/20",
		icon: "text-blue-600 dark:text-blue-400",
		swatch: "bg-blue-500",
	},
	green: {
		border: "border-green-300 dark:border-green-700",
		bg: "bg-green-50 dark:bg-green-900/20",
		icon: "text-green-600 dark:text-green-400",
		swatch: "bg-green-500",
	},
	yellow: {
		border: "border-yellow-300 dark:border-yellow-700",
		bg: "bg-yellow-50 dark:bg-yellow-900/20",
		icon: "text-yellow-600 dark:text-yellow-400",
		swatch: "bg-yellow-500",
	},
	orange: {
		border: "border-orange-300 dark:border-orange-700",
		bg: "bg-orange-50 dark:bg-orange-900/20",
		icon: "text-orange-600 dark:text-orange-400",
		swatch: "bg-orange-500",
	},
	red: {
		border: "border-red-300 dark:border-red-700",
		bg: "bg-red-50 dark:bg-red-900/20",
		icon: "text-red-600 dark:text-red-400",
		swatch: "bg-red-500",
	},
	purple: {
		border: "border-purple-300 dark:border-purple-700",
		bg: "bg-purple-50 dark:bg-purple-900/20",
		icon: "text-purple-600 dark:text-purple-400",
		swatch: "bg-purple-500",
	},
	pink: {
		border: "border-pink-300 dark:border-pink-700",
		bg: "bg-pink-50 dark:bg-pink-900/20",
		icon: "text-pink-600 dark:text-pink-400",
		swatch: "bg-pink-500",
	},
	indigo: {
		border: "border-indigo-300 dark:border-indigo-700",
		bg: "bg-indigo-50 dark:bg-indigo-900/20",
		icon: "text-indigo-600 dark:text-indigo-400",
		swatch: "bg-indigo-500",
	},
	cyan: {
		border: "border-cyan-300 dark:border-cyan-700",
		bg: "bg-cyan-50 dark:bg-cyan-900/20",
		icon: "text-cyan-600 dark:text-cyan-400",
		swatch: "bg-cyan-500",
	},
};

describe("agent colour palette", () => {
	it("lists the ten colours in today's order", () => {
		expect([...AGENT_COLOR_NAMES]).toEqual([
			"gray",
			"blue",
			"green",
			"yellow",
			"orange",
			"red",
			"purple",
			"pink",
			"indigo",
			"cyan",
		]);
	});

	for (const [name, classes] of Object.entries(TODAY)) {
		it(`keeps ${name}'s border, bg, icon and swatch classes`, () => {
			const actual: Record<string, string> =
				AGENT_COLOR_CLASSES[name as keyof typeof TODAY];
			expect(actual).toEqual(classes);
		});
	}

	it("falls back to gray for an unknown colour", () => {
		expect(agentColorClasses("chartreuse")).toEqual(TODAY.gray);
		expect(agentColorClasses("")).toEqual(TODAY.gray);
		expect(agentColorClasses("constructor")).toEqual(TODAY.gray);
		expect(agentColorClasses("blue")).toEqual(TODAY.blue);
	});
});
