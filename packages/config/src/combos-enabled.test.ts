import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Config } from "./index";

function makeConfig(): { config: Config; cleanup: () => void } {
	const dir = mkdtempSync(join(tmpdir(), "hov-router-config-"));
	return {
		config: new Config(join(dir, "config.json")),
		cleanup: () => rmSync(dir, { recursive: true, force: true }),
	};
}

describe("combos and combo session fallback settings", () => {
	it("starts with combos off and the fallback blocked", () => {
		const { config, cleanup } = makeConfig();
		try {
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getCombosEnabledSource()).toBe("default");
			expect(config.getComboSessionFallback()).toBe(false);
			expect(config.getComboSessionFallbackSource()).toBe("default");
		} finally {
			cleanup();
		}
	});

	it("keeps both settings owned by the config file", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(false);
			config.setComboSessionFallback(true);
			expect(config.getCombosEnabled()).toBe(false);
			expect(config.getComboSessionFallback()).toBe(true);
			expect(config.getCombosEnabledSource()).toBe("file");
			expect(config.getComboSessionFallbackSource()).toBe("file");
		} finally {
			cleanup();
		}
	});

	describe("adoptLegacyRoutingSettings", () => {
		it("preserves both historical routing behaviours for an install with combos", () => {
			const { config, cleanup } = makeConfig();
			try {
				const notes = config.adoptLegacyRoutingSettings(true);
				expect(config.getCombosEnabled()).toBe(true);
				expect(config.getComboSessionFallback()).toBe(true);
				expect(config.getComboSessionFallbackSource()).toBe("file");
				expect(notes.length).toBe(2);
			} finally {
				cleanup();
			}
		});

		it("never overwrites a deliberate blocked fallback", () => {
			const { config, cleanup } = makeConfig();
			try {
				config.setComboSessionFallback(false);
				expect(config.adoptLegacyRoutingSettings(true)).toEqual([
					"combos enabled: this install already has combos, so the routing it was already doing is kept. Turn it off in the dashboard Combos tab",
				]);
				expect(config.getComboSessionFallback()).toBe(false);
			} finally {
				cleanup();
			}
		});

		it("leaves a fresh install alone", () => {
			const { config, cleanup } = makeConfig();
			try {
				expect(config.adoptLegacyRoutingSettings(false)).toEqual([]);
				expect(config.getCombosEnabledSource()).toBe("default");
				expect(config.getComboSessionFallbackSource()).toBe("default");
			} finally {
				cleanup();
			}
		});
	});

	it("surfaces both effective values in getAllSettings", () => {
		const { config, cleanup } = makeConfig();
		try {
			config.setCombosEnabled(true);
			config.setComboSessionFallback(true);
			expect(config.getAllSettings().combos_enabled).toBe(true);
			expect(config.getAllSettings().combo_session_fallback).toBe(true);
		} finally {
			cleanup();
		}
	});
});
