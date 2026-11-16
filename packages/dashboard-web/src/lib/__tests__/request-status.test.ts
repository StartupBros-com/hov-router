import { describe, expect, it } from "bun:test";
import { httpStatusTone, requestStatusDisplay } from "../request-status";

describe("httpStatusTone", () => {
	it.each([
		[101, "neutral"],
		[200, "success"],
		[204, "success"],
		[301, "info"],
		[304, "info"],
		[400, "warning"],
		[404, "warning"],
		[429, "warning"],
		[499, "warning"],
		[500, "danger"],
		[503, "danger"],
		[599, "danger"],
		[0, "neutral"],
	] as const)("maps %d to %s", (status, tone) => {
		expect(httpStatusTone(status)).toBe(tone);
	});

	it("maps a missing status to neutral", () => {
		expect(httpStatusTone(undefined)).toBe("neutral");
		expect(httpStatusTone(null)).toBe("neutral");
	});
});

describe("requestStatusDisplay", () => {
	it("shows the status number in its tone", () => {
		expect(
			requestStatusDisplay({ statusCode: 302, pending: false, isError: false }),
		).toEqual({ text: "302", tone: "info" });
		expect(
			requestStatusDisplay({ statusCode: 500, pending: false, isError: true }),
		).toEqual({ text: "500", tone: "danger" });
	});

	it("shows Pending while a request without a status is running", () => {
		expect(
			requestStatusDisplay({
				statusCode: undefined,
				pending: true,
				isError: true,
			}),
		).toEqual({ text: "Pending", tone: "neutral" });
	});

	it("shows No response for a finished request without a status", () => {
		expect(
			requestStatusDisplay({
				statusCode: undefined,
				pending: false,
				isError: true,
			}),
		).toEqual({ text: "No response", tone: "danger" });
		expect(
			requestStatusDisplay({ statusCode: 0, pending: false, isError: false }),
		).toEqual({ text: "No response", tone: "neutral" });
	});
});
