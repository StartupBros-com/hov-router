import { describe, expect, test } from "bun:test";
import {
	NO_ACCOUNT_LABEL,
	recentErrorAccountDetail,
	recentErrorAccountLabel,
} from "../recentErrorAccount";

describe("recentErrorAccountLabel (Recent Errors row)", () => {
	test("names the account that served the request", () => {
		expect(
			recentErrorAccountLabel({ accountId: "acc-1", accountName: "max-one" }),
		).toBe("max-one");
	});

	test("says no account served it when the request has no account", () => {
		// The router stores no account when every candidate refused, none was
		// eligible, or it refused before choosing one. The client still sent its
		// API key, so the row must not read as a failed sign-in.
		const label = recentErrorAccountLabel({
			accountId: null,
			accountName: null,
		});
		expect(label).toBe(NO_ACCOUNT_LABEL);
		expect(label).toBe("No account served it");
		expect(label).not.toContain("Unauthenticated");
	});

	test("marks an account that has since been deleted", () => {
		expect(
			recentErrorAccountLabel({ accountId: "acc-gone", accountName: null }),
		).toBe("Deleted account");
	});
});

describe("recentErrorAccountDetail (error details panel)", () => {
	test("gives the account name and its ID", () => {
		expect(
			recentErrorAccountDetail({ accountId: "acc-1", accountName: "max-one" }),
		).toBe("max-one (ID: acc-1)");
	});

	test("uses the same no-account wording as the row", () => {
		expect(
			recentErrorAccountDetail({ accountId: null, accountName: null }),
		).toBe(NO_ACCOUNT_LABEL);
	});

	test("keeps the ID of a deleted account", () => {
		expect(
			recentErrorAccountDetail({ accountId: "acc-gone", accountName: null }),
		).toBe("Deleted account (ID: acc-gone)");
	});
});
