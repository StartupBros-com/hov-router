import { describe, expect, it } from "bun:test";
import * as identity from "@hov-router/core/product-identity";
import cliPackage from "../../../apps/cli/package.json";
import rootPackage from "../../../package.json";

describe("public product identity", () => {
	it("names the packages and keeps their versions in step", () => {
		expect(rootPackage.name).toBe("hov-router");
		// A workspace may not share the root package's name.
		expect(cliPackage.name).toBe("@hov-router/cli");
		expect(cliPackage.version).toBe(rootPackage.version);
		expect(cliPackage.license).toBe("MIT");
		expect(cliPackage.files).toEqual(["dist/hov-router", "README.md"]);
	});

	it("installs one hov-router command from the build output", () => {
		expect(cliPackage.bin).toEqual({ "hov-router": "dist/hov-router" });
		expect(rootPackage.scripts["hov-router"]).toBe(
			"bun run build && bun run cli",
		);
		for (const retired of ["better-ccflare", "wstack-router"])
			expect(rootPackage.scripts).not.toHaveProperty(retired);
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
