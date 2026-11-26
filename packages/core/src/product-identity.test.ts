import { describe, expect, it } from "bun:test";
import * as identity from "@hov-router/core/product-identity";
import cliPackage from "../../../apps/cli/package.json";
import rootPackage from "../../../package.json";

describe("public product identity", () => {
	it("preserves distribution package names and version agreement", () => {
		expect(rootPackage.name).toBe("hov-router");
		expect(cliPackage.name).toBe("hov-router");
		expect(cliPackage.version).toBe(rootPackage.version);
		expect(cliPackage.license).toBe("MIT");
		expect(cliPackage.files).toEqual(["dist/hov-router", "README.md"]);
	});

	it("adds compatible executable aliases without renaming distribution artifacts", () => {
		expect(cliPackage.bin).toEqual({
			"hov-router": "dist/hov-router",
			"hov-router": "dist/hov-router",
		});
		expect(rootPackage.scripts).toMatchObject({
			"hov-router": "bun run build && bun run cli",
			"hov-router": "bun run build && bun run cli",
		});
		// The interim wstack-router name is no longer installed; existing links
		// still work because the binary ignores the name it was started under.
		expect(rootPackage.scripts).not.toHaveProperty("wstack-router");
	});

	it("points public metadata to the HoV Router home", () => {
		expect(cliPackage.repository.url).toBe(
			"git+https://github.com/StartupBros-com/hov-router.git",
		);
		expect(cliPackage.homepage).toBe(
			"https://github.com/StartupBros-com/hov-router#readme",
		);
		expect(cliPackage.bugs.url).toBe(
			"https://github.com/StartupBros-com/hov-router/issues",
		);
		expect(rootPackage.description).toContain("HoV Router");
		expect(cliPackage.description).toBe(rootPackage.description);
	});

	it("names the product and its one command", () => {
		expect(identity.PRODUCT_NAME).toBe("HoV Router");
		expect(identity.COMMAND_NAME).toBe("hov-router");
		expect(identity.COMMAND_NAMES).toEqual(["hov-router"]);
	});
});
