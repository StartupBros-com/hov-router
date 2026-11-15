import { describe, expect, it } from "bun:test";
import { ERROR_TYPES, formatError, getErrorType, HttpError } from "./index";

const NETWORK_MESSAGE =
	"Network error. Please check your connection and try again.";
const TIMEOUT_MESSAGE = "The request timed out. Please try again.";
// The options the dashboard's useApiError hook passes to formatError.
const DASHBOARD_OPTIONS = {
	errorMap: {
		unauthorized: "Authentication failed. Please re-add your account.",
		401: "Authentication failed (401 Unauthorized). The server rejected the request - likely due to expired or invalid API credentials.",
	},
};

describe("browser fetch failures and timeouts", () => {
	it("treats the browsers' bare fetch failures as network errors", () => {
		for (const error of [
			new TypeError("Failed to fetch"),
			new TypeError("Load failed"),
			new Error("Failed to fetch"),
			new Error("  failed to FETCH "),
		]) {
			expect(getErrorType(error)).toBe(ERROR_TYPES.NETWORK);
			expect(formatError(error)).toBe(NETWORK_MESSAGE);
			expect(formatError(error, DASHBOARD_OPTIONS)).toBe(NETWORK_MESSAGE);
		}
	});

	it("treats the client's 408 and its rewrapped message as a timeout", () => {
		for (const error of [
			new HttpError(408, "Request timeout"),
			new Error("Request timeout"),
		]) {
			expect(getErrorType(error)).toBe(ERROR_TYPES.TIMEOUT);
			expect(formatError(error)).toBe(TIMEOUT_MESSAGE);
			expect(formatError(error, DASHBOARD_OPTIONS)).toBe(TIMEOUT_MESSAGE);
		}
	});

	it("matches the whole message, not a substring", () => {
		expect(formatError(new Error("Failed to fetch requests"))).toBe(
			"Failed to fetch requests",
		);
		expect(formatError(new Error("Load failed for chart"))).toBe(
			"Load failed for chart",
		);
		expect(formatError(new Error("Request timeout after retry"))).toBe(
			"Request timeout after retry",
		);
	});

	it("classifies an HttpError by status before its message", () => {
		expect(getErrorType(new HttpError(500, "Failed to fetch requests"))).toBe(
			ERROR_TYPES.SERVER,
		);
		expect(formatError(new HttpError(500, "Failed to fetch requests"))).toBe(
			"Server error. Please try again later.",
		);
		expect(getErrorType(new HttpError(503, "Failed to fetch"))).toBe(
			ERROR_TYPES.SERVER,
		);
		expect(formatError(new HttpError(404, "Not found"))).toBe(
			"Invalid request. Please check your input.",
		);
		expect(getErrorType(new HttpError(400, "Request timeout"))).toBe(
			ERROR_TYPES.VALIDATION,
		);
	});
});

const messageCases = [
	[
		ERROR_TYPES.NETWORK,
		["network", "fetch failed", "connection", "econnrefused"],
	],
	[ERROR_TYPES.AUTH, ["unauthorized", "authentication", "401", "token"]],
	[ERROR_TYPES.RATE_LIMIT, ["rate limit", "too many requests", "429"]],
	[ERROR_TYPES.VALIDATION, ["validation", "invalid", "bad request"]],
	[ERROR_TYPES.SERVER, ["server error", "500", "502", "503", "504"]],
] as const;

describe("getErrorType message classification", () => {
	for (const [type, patterns] of messageCases) {
		for (const pattern of patterns) {
			it(`classifies ${JSON.stringify(pattern)} as ${type}`, () => {
				expect(
					getErrorType(new Error(`prefix ${pattern.toUpperCase()} suffix`)),
				).toBe(type);
			});
		}
	}

	it("preserves category precedence for overlapping messages", () => {
		expect(
			getErrorType(new Error("network token rate limit invalid server error")),
		).toBe(ERROR_TYPES.NETWORK);
		expect(
			getErrorType(new Error("token rate limit invalid server error")),
		).toBe(ERROR_TYPES.AUTH);
		expect(getErrorType(new Error("rate limit invalid server error"))).toBe(
			ERROR_TYPES.RATE_LIMIT,
		);
		expect(getErrorType(new Error("invalid server error"))).toBe(
			ERROR_TYPES.VALIDATION,
		);
	});

	it("keeps HttpError status classification ahead of message classification", () => {
		expect(getErrorType(new HttpError(500, "network failure"))).toBe(
			ERROR_TYPES.SERVER,
		);
	});
});

describe("HttpError cause compatibility", () => {
	it("keeps details separate from the non-enumerable diagnostic cause", () => {
		const cause = new Error("transport failure");
		const details = { field: "request" };
		const error = new HttpError(408, "Request timeout", details, { cause });
		expect(error.cause).toBe(cause);
		expect(error.details).toBe(details);
		expect(error.status).toBe(408);
		expect(Object.getOwnPropertyDescriptor(error, "cause")?.enumerable).toBe(
			false,
		);
		expect(new HttpError(400, "legacy", details).cause).toBeUndefined();
	});
});
