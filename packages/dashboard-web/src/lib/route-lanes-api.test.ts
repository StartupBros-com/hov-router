import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { parseHttpError } from "@better-ccflare/errors";
import { api } from "../api";
import {
	applyLaneForm,
	EMPTY_LANE_FORM,
	fetchRouteLanes,
	formatLaneSet,
	isStaleRouteLanesError,
	laneFormValues,
	parseLaneSetText,
	type RouteLaneDefinition,
	type RouteLanes,
	removeLane,
	saveRouteLanes,
	upsertLane,
} from "./route-lanes-api";

const opus: RouteLaneDefinition = {
	id: "cvp-opus",
	aliases: ["opus-old"],
	displayName: "CVP Opus",
	accountId: "acct-1",
	logicalModel: "opus",
	defaultEffort: "high",
	contextWindow: 1_000_000,
};
const mythos: RouteLaneDefinition = {
	id: "cvp-mythos",
	displayName: "CVP Mythos",
	accountId: "acct-1",
	logicalModel: "mythos",
};

describe("route lanes API calls", () => {
	const spies: { mockRestore(): void }[] = [];
	afterEach(() => {
		for (const spy of spies.splice(0)) spy.mockRestore();
	});

	it("reads GET /api/route-profiles and returns its data", async () => {
		const data: RouteLanes = {
			revision: 3,
			profiles: [opus],
			lanes: [],
			status: { source: "database", status: "ok", count: 1, revision: 3 },
			warnings: [],
		};
		const get = spyOn(api, "get").mockResolvedValue({ success: true, data });
		spies.push(get);
		expect(await fetchRouteLanes()).toEqual(data);
		expect(get).toHaveBeenCalledWith("/api/route-profiles");
	});

	it("sends the revision and the whole set to PUT /api/route-profiles", async () => {
		const put = spyOn(api, "put").mockResolvedValue({
			success: true,
			data: { revision: 4 },
		});
		spies.push(put);
		const result = await saveRouteLanes({ revision: 3, profiles: [opus] });
		expect(put).toHaveBeenCalledWith("/api/route-profiles", {
			revision: 3,
			profiles: [opus],
		});
		expect(result).toEqual({ revision: 4 } as never);
	});
});

describe("isStaleRouteLanesError", () => {
	// Built the way the real client builds it: parseHttpError keeps the
	// server's `error` string as `details`, not the `details` object.
	const fromResponse = (status: number, body: unknown) =>
		parseHttpError(
			new Response(JSON.stringify(body), {
				status,
				headers: { "content-type": "application/json" },
			}),
		);

	it("recognizes the server's stale-revision conflict", async () => {
		const error = await fromResponse(409, {
			error: "Route lanes changed since revision 4",
			details: { code: "stale_route_profiles", revision: 5 },
		});
		expect(isStaleRouteLanesError(error)).toBe(true);
	});

	it("does not treat other errors as stale", async () => {
		const invalid = await fromResponse(400, {
			error: "profile 0 contains unknown field nope",
			details: { code: "invalid_route_profiles" },
		});
		expect(isStaleRouteLanesError(invalid)).toBe(false);
		expect(invalid.message).toBe("profile 0 contains unknown field nope");
		expect(isStaleRouteLanesError(new Error("network"))).toBe(false);
	});
});

describe("the lane form", () => {
	it("reads the form fields from a lane", () => {
		expect(laneFormValues(opus)).toEqual({
			id: "cvp-opus",
			displayName: "CVP Opus",
			accountId: "acct-1",
			logicalModel: "opus",
			description: "",
			exclusiveAccount: false,
		});
	});

	it("keeps every field it does not edit, exactly as written", () => {
		const next = applyLaneForm(opus, {
			...laneFormValues(opus),
			displayName: "  CVP Opus Max ",
			accountId: "acct-2",
			exclusiveAccount: true,
		});
		expect(next).toEqual({
			id: "cvp-opus",
			aliases: ["opus-old"],
			displayName: "CVP Opus Max",
			accountId: "acct-2",
			logicalModel: "opus",
			defaultEffort: "high",
			contextWindow: 1_000_000,
			exclusiveAccount: true,
		});
	});

	it("removes blank optional fields instead of sending empty strings", () => {
		const next = applyLaneForm(
			{ ...mythos, description: "old", exclusiveAccount: true },
			{ ...laneFormValues(mythos), description: "  ", exclusiveAccount: false },
		);
		expect(next).not.toHaveProperty("description");
		expect(next).not.toHaveProperty("exclusiveAccount");
	});

	it("builds a new lane from the empty form", () => {
		expect(
			applyLaneForm(undefined, {
				...EMPTY_LANE_FORM,
				id: "cvp-sonnet",
				displayName: "CVP Sonnet",
				accountId: "acct-3",
				logicalModel: "sonnet",
			}),
		).toEqual({
			id: "cvp-sonnet",
			displayName: "CVP Sonnet",
			accountId: "acct-3",
			logicalModel: "sonnet",
		});
	});
});

describe("editing the set", () => {
	it("replaces a lane in place, keeping the order", () => {
		const renamed = { ...opus, id: "cvp-opus-max" };
		expect(
			upsertLane([opus, mythos], "cvp-opus", renamed).map((p) => p.id),
		).toEqual(["cvp-opus-max", "cvp-mythos"]);
	});

	it("appends a new lane, and a lane whose original is gone", () => {
		expect(upsertLane([opus], null, mythos).map((p) => p.id)).toEqual([
			"cvp-opus",
			"cvp-mythos",
		]);
		expect(upsertLane([opus], "missing", mythos).map((p) => p.id)).toEqual([
			"cvp-opus",
			"cvp-mythos",
		]);
	});

	it("removes one lane by id", () => {
		expect(removeLane([opus, mythos], "cvp-opus")).toEqual([mythos]);
	});
});

describe("the JSON view", () => {
	it("round-trips the set it shows", () => {
		const parsed = parseLaneSetText(formatLaneSet([opus, mythos]));
		expect(parsed).toEqual({ ok: true, profiles: [opus, mythos] });
	});

	it("refuses text that is not a JSON array of lanes", () => {
		expect(parseLaneSetText("{")).toMatchObject({ ok: false });
		expect(parseLaneSetText('{"id":"x"}')).toEqual({
			ok: false,
			error: "The lane set must be a JSON array",
		});
		expect(parseLaneSetText('[{"id":"a"}, 3]')).toEqual({
			ok: false,
			error: "Lane 1 must be an object with a string id",
		});
	});

	it("leaves field validation to the server", () => {
		expect(parseLaneSetText('[{"id":"a","nope":1}]')).toEqual({
			ok: true,
			profiles: [{ id: "a", nope: 1 }],
		});
	});
});
