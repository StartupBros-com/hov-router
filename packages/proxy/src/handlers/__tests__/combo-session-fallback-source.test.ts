import { describe, expect, it } from "bun:test";
import { isComboSessionFallbackDisabled } from "../account-selector";
import type { ProxyContext } from "../proxy-types";

// The guard reads the config and nothing else.

function ctxWith(fallbackAllowed?: boolean): ProxyContext {
	return (fallbackAllowed === undefined
		? {}
		: {
				config: { getComboSessionFallback: () => fallbackAllowed },
			}) as unknown as ProxyContext;
}

describe("isComboSessionFallbackDisabled", () => {
	it("reads the config", () => {
		expect(isComboSessionFallbackDisabled(ctxWith(false))).toBe(true);
		expect(isComboSessionFallbackDisabled(ctxWith(true))).toBe(false);
	});

	it("leaves a context without a config on the historical behaviour", () => {
		// No config means no operator to ask. Applying the new default there
		// would change what happens for callers who never chose it.
		expect(isComboSessionFallbackDisabled(ctxWith())).toBe(false);
	});
});
