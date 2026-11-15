/**
 * Provider names - duplicated here to avoid circular dependencies
 */
export const PROVIDER_NAMES = {
	ANTHROPIC: "anthropic", // Claude OAuth accounts
	CLAUDE_CONSOLE_API: "claude-console-api", // Claude API console accounts
	ZAI: "zai",
	MINIMAX: "minimax",
	DEEPSEEK: "deepseek",
	ANTHROPIC_COMPATIBLE: "anthropic-compatible",
	OPENAI_COMPATIBLE: "openai-compatible",
	NANOGPT: "nanogpt",
	VERTEX_AI: "vertex-ai",
	BEDROCK: "bedrock",
	KILO: "kilo",
	OPENROUTER: "openrouter",
	ALIBABA_CODING_PLAN: "alibaba-coding-plan",
	CODEX: "codex",
	QWEN: "qwen",
	XAI: "xai",
	OLLAMA: "ollama",
	OLLAMA_CLOUD: "ollama-cloud",
	META: "meta",
} as const;

export type ProviderName = (typeof PROVIDER_NAMES)[keyof typeof PROVIDER_NAMES];

/**
 * Type guard to check if a provider string is a known ProviderName
 */
export function isKnownProvider(provider: string): provider is ProviderName {
	return (Object.values(PROVIDER_NAMES) as string[]).includes(provider);
}

/**
 * How a request is billed: `plan` draws on a subscription or an included
 * allowance, `api` is charged per use.
 */
export type DefaultBillingType = "plan" | "api";

/**
 * Detailed provider configuration interface
 */
export interface ProviderConfig {
	/** Whether the provider requires session duration tracking (usage windows like Anthropic's 5-hour windows) */
	requiresSessionTracking: boolean;
	/** Whether the provider supports usage tracking via OAuth usage endpoint */
	supportsUsageTracking: boolean;
	/** Whether the provider supports OAuth authentication */
	supportsOAuth: boolean;
	/**
	 * The billing label a request gets when the account sets no billing type and
	 * the response carries no overage signal. Only the usage recorder reads it:
	 * route class and usage-window comparison classify accounts on their own.
	 */
	defaultBillingType: DefaultBillingType;
	/** Default API endpoint for the provider */
	defaultEndpoint?: string;
}

/**
 * Provider-specific configuration mapping
 */
export const PROVIDER_CONFIG: Record<ProviderName, ProviderConfig> = {
	[PROVIDER_NAMES.ANTHROPIC]: {
		requiresSessionTracking: true, // Anthropic OAuth has 5-hour usage windows
		supportsUsageTracking: true, // Anthropic OAuth supports usage tracking
		supportsOAuth: true, // Anthropic OAuth uses OAuth authentication
		defaultBillingType: "plan",
		defaultEndpoint: "https://api.anthropic.com",
	},
	[PROVIDER_NAMES.CLAUDE_CONSOLE_API]: {
		requiresSessionTracking: false, // Claude console API is pay-as-you-go
		supportsUsageTracking: false, // Claude console API doesn't support usage tracking
		supportsOAuth: false, // Claude console API uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://api.anthropic.com",
	},
	[PROVIDER_NAMES.ZAI]: {
		requiresSessionTracking: true, // Zai has 5-hour session windows
		supportsUsageTracking: true, // Zai supports usage tracking via monitoring API
		supportsOAuth: false, // Zai uses API key authentication
		defaultBillingType: "plan",
		defaultEndpoint: "https://api.z.ai/api/anthropic",
	},
	[PROVIDER_NAMES.MINIMAX]: {
		requiresSessionTracking: false, // Minimax is pay-as-you-go
		supportsUsageTracking: true, // Minimax exposes Token Plan remains via /v1/token_plan/remains (polling only; request forwarding still goes through the generic anthropic-compatible path)
		supportsOAuth: false, // Minimax uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://api.minimax.io/anthropic",
	},
	[PROVIDER_NAMES.DEEPSEEK]: {
		requiresSessionTracking: false, // DeepSeek is pay-as-you-go
		supportsUsageTracking: false, // No known usage/quota polling API
		supportsOAuth: false, // DeepSeek uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://api.deepseek.com/anthropic",
	},
	[PROVIDER_NAMES.ANTHROPIC_COMPATIBLE]: {
		requiresSessionTracking: false, // Anthropic-compatible is pay-as-you-go
		supportsUsageTracking: false, // Anthropic-compatible providers typically don't support usage tracking
		supportsOAuth: false, // Anthropic-compatible uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://api.anthropic.com", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.OPENAI_COMPATIBLE]: {
		requiresSessionTracking: false, // OpenAI-compatible is typically pay-as-you-go
		supportsUsageTracking: false, // OpenAI-compatible providers typically don't support usage tracking
		supportsOAuth: false, // OpenAI-compatible uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://api.anthropic.com", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.NANOGPT]: {
		requiresSessionTracking: false, // NanoGPT is pay-as-you-go (no session stickiness)
		supportsUsageTracking: true, // NanoGPT supports subscription usage tracking via API
		supportsOAuth: false, // NanoGPT uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://nano-gpt.com/api", // Default, can be overridden via custom endpoint
	},
	[PROVIDER_NAMES.VERTEX_AI]: {
		requiresSessionTracking: false, // Vertex AI is pay-as-you-go via Google Cloud billing
		supportsUsageTracking: false, // Vertex AI doesn't have a usage tracking API
		supportsOAuth: false, // Vertex AI uses Google Cloud authentication (not Anthropic OAuth)
		defaultBillingType: "api",
		defaultEndpoint: "https://aiplatform.googleapis.com",
	},
	[PROVIDER_NAMES.BEDROCK]: {
		requiresSessionTracking: false, // Pay-as-you-go, no 5-hour windows
		supportsUsageTracking: false, // Usage extracted per-request, not via polling API
		supportsOAuth: false, // AWS credentials, not OAuth
		defaultBillingType: "api",
		defaultEndpoint: "bedrock://aws", // Placeholder (SDK-based, not HTTP)
	},
	[PROVIDER_NAMES.KILO]: {
		requiresSessionTracking: false, // Kilo is credit-based, no session windows
		supportsUsageTracking: true, // Kilo supports credit balance via /api/user
		supportsOAuth: false, // Kilo uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://api.kilo.ai/api/gateway",
	},
	[PROVIDER_NAMES.OPENROUTER]: {
		requiresSessionTracking: false, // OpenRouter is pay-as-you-go
		supportsUsageTracking: false, // Credits endpoint requires a separate management key
		supportsOAuth: false, // OpenRouter uses API key authentication
		defaultBillingType: "api",
		defaultEndpoint: "https://openrouter.ai/api/v1",
	},
	[PROVIDER_NAMES.ALIBABA_CODING_PLAN]: {
		requiresSessionTracking: false, // Alibaba Coding Plan uses quota windows, not session stickiness
		supportsUsageTracking: false, // Usage endpoint requires session cookies, not API key
		supportsOAuth: false, // Uses API key authentication
		defaultBillingType: "plan",
		defaultEndpoint:
			"https://coding-intl.dashscope.aliyuncs.com/apps/anthropic",
	},
	[PROVIDER_NAMES.CODEX]: {
		requiresSessionTracking: true, // Codex has 5h/7d usage windows like Anthropic OAuth
		supportsUsageTracking: true, // Polled for free from the ChatGPT backend's wham/usage endpoint; x-codex-* response headers remain a passive fallback
		supportsOAuth: true, // Codex uses OpenAI OAuth with PKCE
		defaultBillingType: "plan",
		defaultEndpoint: "https://chatgpt.com/backend-api/codex/responses",
	},
	[PROVIDER_NAMES.QWEN]: {
		requiresSessionTracking: false, // Qwen OAuth is quota-based, no session stickiness
		supportsUsageTracking: true, // Usage tracked via response body (OpenAI-compatible)
		supportsOAuth: true, // Qwen uses OAuth 2.0 device code flow
		defaultBillingType: "plan",
		defaultEndpoint: "https://dashscope.aliyuncs.com/compatible-mode/v1",
	},
	[PROVIDER_NAMES.XAI]: {
		requiresSessionTracking: false, // Grok Build credits reset by billing window, not session stickiness
		supportsUsageTracking: true, // Grok CLI OAuth bearer can poll grok.com Grok Build credits via gRPC-web
		supportsOAuth: true, // Imports/refreshes Grok CLI OAuth credentials
		defaultBillingType: "plan", // Grok Build draws on a credit pool that resets weekly
		defaultEndpoint: "https://api.x.ai/v1",
	},
	[PROVIDER_NAMES.OLLAMA]: {
		requiresSessionTracking: false,
		supportsUsageTracking: false,
		supportsOAuth: false,
		defaultBillingType: "plan",
		defaultEndpoint: "http://localhost:11434",
	},
	[PROVIDER_NAMES.OLLAMA_CLOUD]: {
		requiresSessionTracking: false,
		supportsUsageTracking: false,
		supportsOAuth: false,
		defaultBillingType: "plan",
		defaultEndpoint: "https://ollama.com",
	},
	[PROVIDER_NAMES.META]: {
		requiresSessionTracking: false, // Meta Model API is pay-as-you-go, no session windows
		supportsUsageTracking: false, // Quota is reported per-response via x-ratelimit-* headers, not a polling API
		supportsOAuth: false, // Meta Model API uses a bearer API key
		defaultBillingType: "api",
		defaultEndpoint: "https://api.meta.ai",
	},
} as const satisfies Record<ProviderName, ProviderConfig>;

/**
 * Check if a provider should have session duration tracking
 * Currently only Anthropic providers have usage windows that benefit from session tracking
 * This can be extended for other providers with similar usage window systems (OpenAI-compatible, Anthropic-compatible, etc.)
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider requires session duration tracking, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function requiresSessionDurationTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no session tracking (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no session tracking (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].requiresSessionTracking;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Check if a provider supports usage tracking
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider supports usage tracking, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsUsageTracking(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no usage tracking (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no usage tracking (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].supportsUsageTracking;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * Check if a provider supports OAuth authentication
 *
 * @param provider - The provider name to check
 * @returns boolean - True if the provider supports OAuth, false otherwise
 *                    Unknown providers default to false (security through default denial)
 */
export function supportsOAuth(provider: string): boolean {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - defaults to no OAuth support (security through default denial)
		console.warn(
			`Unknown provider: ${provider}. Defaulting to no OAuth support (security through default denial).`,
		);
		return false;
	}

	if (provider in PROVIDER_CONFIG) {
		return PROVIDER_CONFIG[provider].supportsOAuth;
	}

	// Default to false for any provider not explicitly configured (security through default denial)
	return false;
}

/**
 * The billing label for a provider's requests when the account sets no billing
 * type. A provider this table does not know is `api`: nothing says it draws on
 * a plan.
 */
export function getDefaultBillingType(provider: string): DefaultBillingType {
	return isKnownProvider(provider)
		? PROVIDER_CONFIG[provider].defaultBillingType
		: "api";
}

/**
 * Get the default endpoint for a provider
 *
 * @param provider - The provider name to check
 * @returns string - The default endpoint for the provider, or a fallback if unknown
 */
export function getDefaultEndpoint(provider: string): string {
	if (!isKnownProvider(provider)) {
		// Log warning for unknown providers - return a default fallback
		console.warn(`Unknown provider: ${provider}. Using fallback endpoint.`);
		return "https://api.anthropic.com";
	}

	if (provider in PROVIDER_CONFIG) {
		return (
			PROVIDER_CONFIG[provider].defaultEndpoint || "https://api.anthropic.com"
		);
	}

	// Default to Anthropic API endpoint for any provider not explicitly configured
	return "https://api.anthropic.com";
}
