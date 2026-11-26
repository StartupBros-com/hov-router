import type { RecentErrorGroup } from "@hov-router/types";

type AccountFields = Pick<RecentErrorGroup, "accountId" | "accountName">;

/**
 * The account shown for a Recent Errors group whose requests have no account.
 * The router stores none when no account served the request: every candidate
 * refused it, none was eligible, the router refused before choosing one, or it
 * was forwarded in no-account fallback mode. It says nothing about the
 * client's own authentication, so it must not read as a failed sign-in.
 */
export const NO_ACCOUNT_LABEL = "No account served it";

/** Account text for a Recent Errors row. */
export function recentErrorAccountLabel(error: AccountFields): string {
	if (error.accountName) return error.accountName;
	if (error.accountId === null) return NO_ACCOUNT_LABEL;
	return "Deleted account";
}

/** Account text for the error details panel, with the account ID. */
export function recentErrorAccountDetail(error: AccountFields): string {
	if (error.accountName)
		return `${error.accountName} (ID: ${error.accountId ?? "unknown"})`;
	if (error.accountId === null) return NO_ACCOUNT_LABEL;
	return `Deleted account (ID: ${error.accountId})`;
}
