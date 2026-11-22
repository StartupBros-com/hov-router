import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LATEST_MYTHOS_MODEL } from "@better-ccflare/core";
import {
	ModelRouteProfileController,
	type ModelRouteProfileStore,
	ModelRouteProfilesConflictError,
	ModelRouteProfilesInvalidError,
	ModelRouteProfilesUnavailableError,
	type StoredModelRouteProfiles,
} from "../model-route-profile-controller";
import {
	MODEL_ROUTE_PROFILES_ENV,
	ModelRouteSessionRegistry,
} from "../model-route-profiles";
import {
	activeModelRouteProfiles,
	MODEL_ROUTE_PROFILES_FILE_ENV,
	setActiveModelRouteProfiles,
} from "../model-route-profiles-source";

const ACCOUNT_A = "aaaaaaaa-0000-4000-8000-000000000001";
const ACCOUNT_B = "bbbbbbbb-0000-4000-8000-000000000002";

const lane = (fields: Record<string, unknown> = {}) => ({
	id: "cvp-opus",
	displayName: "CVP Opus",
	accountId: ACCOUNT_A,
	logicalModel: "opus",
	...fields,
});

function sha256(text: string): string {
	return createHash("sha256").update(text).digest("hex");
}

/** Same compare-and-swap contract as RouteProfileConfigRepository. */
class MemoryStore implements ModelRouteProfileStore {
	row: StoredModelRouteProfiles | null = null;
	failSave: Error | null = null;
	failRead: Error | null = null;
	saves: Array<{ expectedRevision: number; source: string }> = [];
	/** Runs inside a save before it lands, to simulate a competing writer. */
	beforeSave: (() => void) | null = null;

	async getModelRouteProfileConfig() {
		if (this.failRead) throw this.failRead;
		return this.row ? { ...this.row } : null;
	}

	async getModelRouteProfileRevision() {
		if (this.failRead) throw this.failRead;
		return this.row?.revision ?? null;
	}

	async saveModelRouteProfileConfig(input: {
		raw: string;
		expectedRevision: number;
		source: string;
		now: number;
	}) {
		this.saves.push({
			expectedRevision: input.expectedRevision,
			source: input.source,
		});
		if (this.failSave) throw this.failSave;
		this.beforeSave?.();
		const current = this.row?.revision ?? 0;
		if (current !== input.expectedRevision) return null;
		this.row = {
			raw: input.raw,
			revision: current + 1,
			updatedAt: input.now,
			source: input.source,
		};
		return current + 1;
	}

	/** Another backend's write. */
	write(raw: string, source = "api") {
		const revision = (this.row?.revision ?? 0) + 1;
		this.row = { raw, revision, updatedAt: 1, source };
	}
}

let dir: string;
let profilesPath: string;
let lastGoodPath: string;
let store: MemoryStore;
let controller: ModelRouteProfileController | undefined;

function writeProfiles(text: string): void {
	writeFileSync(profilesPath, text);
	chmodSync(profilesPath, 0o640);
}

function start(env: Record<string, string | undefined> = {}) {
	return ModelRouteProfileController.start({
		store,
		env,
		lastGoodPath,
		now: () => 1234,
	}).then((started) => {
		controller = started;
		return started;
	});
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "route-profile-controller-"));
	profilesPath = join(dir, "model-route-profiles.json");
	lastGoodPath = join(dir, "state", "model-route-profiles.last-good.json");
	store = new MemoryStore();
});

afterEach(() => {
	controller?.stopRevisionWatch();
	controller = undefined;
	rmSync(dir, { recursive: true, force: true });
	setActiveModelRouteProfiles(undefined);
});

describe("ModelRouteProfileController.start (#971)", () => {
	it("serves the stored lanes and reports a still-set file variable as ignored", async () => {
		const raw = `${JSON.stringify([lane()])}\n`;
		store.write(raw);
		writeProfiles(JSON.stringify([lane({ id: "from-file" })]));
		const started = await start({
			[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
		});
		expect(started.getProfiles().map((p) => p.id)).toEqual(["cvp-opus"]);
		expect(started.getStatus()).toEqual({
			source: "database",
			status: "ok",
			count: 1,
			sha256: sha256(raw),
			revision: 1,
			ignored: "file",
		});
		expect(started.getDefinitions()).toEqual([lane()]);
		expect(activeModelRouteProfiles().map((p) => p.id)).toEqual(["cvp-opus"]);
		expect(store.saves).toEqual([]);
	});

	it("keeps a stored family name, resolving it only when loaded", async () => {
		store.write(JSON.stringify([lane({ logicalModel: "mythos" })]));
		const started = await start();
		expect(started.getProfiles()[0]?.logicalModel).toBe(LATEST_MYTHOS_MODEL);
		expect(started.getDefinitions()).toEqual([
			lane({ logicalModel: "mythos" }),
		]);
	});

	it("imports the profiles file byte for byte on first start, keeping its sha256", async () => {
		const text = `[\n  ${JSON.stringify(lane())}\n]\n`;
		writeProfiles(text);
		const started = await start({
			[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
		});
		expect(store.row).toEqual({
			raw: text,
			revision: 1,
			updatedAt: 1234,
			source: "import:file",
		});
		expect(started.getStatus()).toEqual({
			source: "database",
			status: "ok",
			count: 1,
			sha256: sha256(text),
			revision: 1,
			ignored: "file",
		});
	});

	it("imports the environment variable on first start", async () => {
		const raw = JSON.stringify([lane()]);
		const started = await start({ [MODEL_ROUTE_PROFILES_ENV]: raw });
		expect(store.row?.raw).toBe(raw);
		expect(store.row?.source).toBe("import:env");
		expect(started.getStatus()).toMatchObject({
			source: "database",
			revision: 1,
			ignored: "env",
		});
	});

	it("writes nothing when no lanes are configured anywhere", async () => {
		const started = await start();
		expect(started.getProfiles()).toEqual([]);
		expect(started.getStatus()).toEqual({
			source: "none",
			status: "ok",
			count: 0,
		});
		expect(started.getRevision()).toBe(0);
		expect(started.getDefinitions()).toEqual([]);
		expect(store.saves).toEqual([]);
	});

	it("does not import a file that only loaded from its last-good copy", async () => {
		writeProfiles(JSON.stringify([lane()]));
		// A run without a store saves the last-good copy, then the file breaks.
		await ModelRouteProfileController.start({
			env: { [MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath },
			lastGoodPath,
		});
		writeProfiles("{ not json");
		const started = await start({
			[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
		});
		expect(started.getStatus()).toMatchObject({
			source: "file",
			status: "last_good",
			count: 1,
		});
		expect(store.saves).toEqual([]);
		expect(store.row).toBeNull();
	});

	it("serves the file for this run when the import cannot be written", async () => {
		writeProfiles(JSON.stringify([lane()]));
		store.failSave = new Error("disk I/O error");
		const started = await start({
			[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
		});
		expect(started.getProfiles().map((p) => p.id)).toEqual(["cvp-opus"]);
		expect(started.getStatus()).toMatchObject({ source: "file", status: "ok" });
		expect(started.getRevision()).toBe(0);
	});

	it("uses what another backend stored first when two imports race", async () => {
		writeProfiles(JSON.stringify([lane()]));
		const other = JSON.stringify([lane({ id: "won-the-race" })]);
		store.beforeSave = () => {
			store.beforeSave = null;
			store.write(other, "import:file");
		};
		const started = await start({
			[MODEL_ROUTE_PROFILES_FILE_ENV]: profilesPath,
		});
		expect(started.getProfiles().map((p) => p.id)).toEqual(["won-the-race"]);
		expect(started.getStatus()).toMatchObject({
			source: "database",
			revision: 1,
			sha256: sha256(other),
		});
	});

	it("refuses to start when the stored lanes do not parse in this build", async () => {
		store.write(JSON.stringify([lane({ unknownField: true })]));
		await expect(start()).rejects.toThrow(
			"stored route profiles (revision 1) do not parse in this build: profile 0 contains unknown field unknownField",
		);
	});
});

describe("ModelRouteProfileController.replace (#971)", () => {
	it("stores a valid set as the next revision and applies it everywhere at once", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		const registry = new ModelRouteSessionRegistry(started.getProfiles());
		started.attachRegistry(registry);

		const next = [
			lane({ accountId: ACCOUNT_B }),
			lane({ id: "cvp-mythos", logicalModel: "mythos" }),
		];
		await started.replace({ revision: 1, profiles: next });

		const raw = `${JSON.stringify(next, null, 2)}\n`;
		expect(store.row).toMatchObject({ raw, revision: 2, source: "api" });
		expect(started.getRevision()).toBe(2);
		expect(started.getDefinitions()).toEqual(next);
		expect(started.getStatus()).toEqual({
			source: "database",
			status: "ok",
			count: 2,
			sha256: sha256(raw),
			revision: 2,
		});
		expect(registry.hasPublicModelId("claude-bccf-route-cvp-mythos")).toBe(
			true,
		);
		expect(registry.isExactProfileRouteForAccount("cvp-opus", ACCOUNT_B)).toBe(
			true,
		);
		expect(activeModelRouteProfiles().map((p) => p.id)).toEqual([
			"cvp-opus",
			"cvp-mythos",
		]);
	});

	it("creates the first stored set with revision 0", async () => {
		const started = await start();
		await started.replace({ revision: 0, profiles: [lane()] });
		expect(started.getStatus()).toMatchObject({
			source: "database",
			revision: 1,
		});
	});

	it("refuses an invalid set with the parser's message and changes nothing", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		const before = store.row;
		const attempt = started.replace({
			revision: 1,
			profiles: [lane(), lane()],
		});
		await expect(attempt).rejects.toBeInstanceOf(
			ModelRouteProfilesInvalidError,
		);
		await expect(attempt).rejects.toThrow(
			"duplicate profile or public model id: cvp-opus",
		);
		expect(store.row).toBe(before);
		expect(store.saves).toEqual([]);
		expect(started.getRevision()).toBe(1);
	});

	it("refuses a body that is not a revision and a profile array", async () => {
		const started = await start();
		for (const input of [
			{ revision: 0, profiles: { id: "x" } },
			{ revision: -1, profiles: [] },
			{ revision: 1.5, profiles: [] },
			{ revision: "1", profiles: [] },
			{ profiles: [] },
		]) {
			await expect(started.replace(input)).rejects.toBeInstanceOf(
				ModelRouteProfilesInvalidError,
			);
		}
	});

	it("refuses a set larger than 256 KiB", async () => {
		const started = await start();
		const profiles = [lane({ description: "x".repeat(400) })];
		const huge = Array.from({ length: 700 }, () => profiles[0]);
		await expect(
			started.replace({ revision: 0, profiles: huge }),
		).rejects.toThrow("at most 256 KiB");
	});

	it("answers a stale revision with a conflict and picks up the newer set", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		store.write(JSON.stringify([lane({ id: "newer" })]));
		const attempt = started.replace({ revision: 1, profiles: [lane()] });
		await expect(attempt).rejects.toBeInstanceOf(
			ModelRouteProfilesConflictError,
		);
		await attempt.catch((error: ModelRouteProfilesConflictError) => {
			expect(error.currentRevision).toBe(2);
		});
		expect(started.getRevision()).toBe(2);
		expect(started.getProfiles().map((p) => p.id)).toEqual(["newer"]);
	});

	it("is unavailable without a store", async () => {
		const started = await ModelRouteProfileController.start({ env: {} });
		controller = started;
		await expect(
			started.replace({ revision: 0, profiles: [] }),
		).rejects.toBeInstanceOf(ModelRouteProfilesUnavailableError);
	});
});

describe("ModelRouteProfileController.reconcile (#971)", () => {
	it("applies a set another backend stored", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		const registry = new ModelRouteSessionRegistry(started.getProfiles());
		started.attachRegistry(registry);

		expect(await started.reconcile()).toBe(false);
		store.write(JSON.stringify([lane({ id: "edited-elsewhere" })]));
		expect(await started.reconcile()).toBe(true);
		expect(started.getRevision()).toBe(2);
		expect(
			registry.hasPublicModelId("claude-bccf-route-edited-elsewhere"),
		).toBe(true);
		expect(registry.hasPublicModelId("claude-bccf-route-cvp-opus")).toBe(false);
	});

	it("keeps serving the current set when a newer stored one does not parse here", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		store.write(JSON.stringify([lane({ fieldFromANewerBuild: 1 })]));
		expect(await started.reconcile()).toBe(false);
		expect(started.getRevision()).toBe(1);
		expect(started.getProfiles().map((p) => p.id)).toEqual(["cvp-opus"]);
		// The rejected revision is not re-read on every check.
		store.failRead = null;
		expect(await started.reconcile()).toBe(false);
	});

	it("survives a read failure", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		store.failRead = new Error("database is locked");
		expect(await started.reconcile()).toBe(false);
		expect(started.getRevision()).toBe(1);
	});

	it("checks on an interval once the watch starts, and stops with it", async () => {
		store.write(JSON.stringify([lane()]));
		const started = await start();
		started.startRevisionWatch(5);
		store.write(JSON.stringify([lane({ id: "picked-up" })]));
		const deadline = Date.now() + 2000;
		while (started.getRevision() !== 2 && Date.now() < deadline) {
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		expect(started.getProfiles().map((p) => p.id)).toEqual(["picked-up"]);
		started.stopRevisionWatch();
		store.write(JSON.stringify([lane({ id: "after-stop" })]));
		await new Promise((resolve) => setTimeout(resolve, 30));
		expect(started.getRevision()).toBe(2);
	});
});
