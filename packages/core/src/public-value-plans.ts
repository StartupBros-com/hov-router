/**
 * Subscription plans an operator can attach to a published account. The public
 * value feed sends the six-key object from `publicValuePlanObject`; the House
 * of Vibe value page validates it strictly. Every price below was read on the
 * provider's page on the date it carries. Add a plan only after reading its
 * price on a provider page.
 */
export interface PublicValuePlan {
	key: string;
	/** The router's account provider value this plan applies to. */
	provider: string;
	name: string;
	formerName: string | null;
	monthlyUsd: number;
	priceSource: string;
	priceCheckedOn: string;
}

/** The plan as the public feed sends it: no provider, keys in this order. */
export interface PublicValuePlanObject {
	key: string;
	name: string;
	formerName: string | null;
	monthlyUsd: number;
	priceSource: string;
	priceCheckedOn: string;
}

const CLAUDE_PRICING = "https://claude.com/pricing";
const CHATGPT_PRICING = "https://help.openai.com/en/articles/9793128";
const CHECKED_ON = "2026-11-23";

export const PUBLIC_VALUE_PLANS: readonly PublicValuePlan[] = [
	{
		key: "claude-pro",
		provider: "anthropic",
		name: "Claude Pro",
		formerName: null,
		monthlyUsd: 20,
		priceSource: CLAUDE_PRICING,
		priceCheckedOn: CHECKED_ON,
	},
	{
		key: "claude-max",
		provider: "anthropic",
		name: "Claude Max",
		formerName: "Claude Max 5x",
		monthlyUsd: 100,
		priceSource: CLAUDE_PRICING,
		priceCheckedOn: CHECKED_ON,
	},
	{
		key: "claude-ultra",
		provider: "anthropic",
		name: "Claude Ultra",
		formerName: "Claude Max 20x",
		monthlyUsd: 200,
		priceSource: CLAUDE_PRICING,
		priceCheckedOn: CHECKED_ON,
	},
	{
		key: "chatgpt-pro-100",
		provider: "codex",
		name: "ChatGPT Pro 100",
		formerName: null,
		monthlyUsd: 100,
		priceSource: CHATGPT_PRICING,
		priceCheckedOn: CHECKED_ON,
	},
	{
		key: "chatgpt-pro-200",
		provider: "codex",
		name: "ChatGPT Pro 200",
		formerName: null,
		monthlyUsd: 200,
		priceSource: CHATGPT_PRICING,
		priceCheckedOn: CHECKED_ON,
	},
	{
		key: "chatgpt-pro-500",
		provider: "codex",
		name: "ChatGPT Pro 500",
		formerName: null,
		monthlyUsd: 500,
		priceSource: CHATGPT_PRICING,
		priceCheckedOn: CHECKED_ON,
	},
];

export function getPublicValuePlan(key: string): PublicValuePlan | undefined {
	return PUBLIC_VALUE_PLANS.find((plan) => plan.key === key);
}

export function publicValuePlanObject(
	plan: PublicValuePlan,
): PublicValuePlanObject {
	return {
		key: plan.key,
		name: plan.name,
		formerName: plan.formerName,
		monthlyUsd: plan.monthlyUsd,
		priceSource: plan.priceSource,
		priceCheckedOn: plan.priceCheckedOn,
	};
}
