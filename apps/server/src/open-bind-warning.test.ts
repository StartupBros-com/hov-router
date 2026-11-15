import { describe, expect, it } from "bun:test";
import {
	COMMAND_NAME,
	PRODUCT_NAME,
} from "@better-ccflare/core/product-identity";
import {
	isLoopbackBind,
	openBindWarning,
	warnIfOpenBind,
} from "./open-bind-warning";

describe("isLoopbackBind", () => {
	it.each([
		"127.0.0.1",
		"127.0.0.2",
		"127.255.255.254",
		"localhost",
		"LOCALHOST",
		" localhost ",
		"::1",
		"[::1]",
	])("treats %p as loopback only", (hostname) => {
		expect(isLoopbackBind(hostname)).toBe(true);
	});

	// Anything not provably loopback counts as reachable from other machines:
	// a missed warning is worse than a spurious one.
	it.each([
		"0.0.0.0",
		"::",
		"[::]",
		"192.168.1.20",
		"10.0.0.5",
		"100.64.0.7",
		"router.lan",
		"0:0:0:0:0:0:0:1",
		"",
	])("treats %p as reachable beyond loopback", (hostname) => {
		expect(isLoopbackBind(hostname)).toBe(false);
	});
});

describe("openBindWarning", () => {
	it.each([
		"0.0.0.0",
		"::",
		"192.168.1.20",
	])("warns when %p is bound and no API key exists", (hostname) => {
		const message = openBindWarning({
			hostname,
			port: 8080,
			authenticationEnabled: false,
		});
		expect(message).not.toBeNull();
	});

	it.each([
		"127.0.0.1",
		"127.0.0.2",
		"localhost",
		"::1",
	])("stays silent on loopback bind %p without a key", (hostname) => {
		expect(
			openBindWarning({
				hostname,
				port: 8080,
				authenticationEnabled: false,
			}),
		).toBeNull();
	});

	it.each([
		"0.0.0.0",
		"::",
		"192.168.1.20",
		"127.0.0.1",
	])("stays silent on %p once an API key exists", (hostname) => {
		expect(
			openBindWarning({
				hostname,
				port: 8080,
				authenticationEnabled: true,
			}),
		).toBeNull();
	});

	it("names the address, the risk and both remedies on one line", () => {
		const message = openBindWarning({
			hostname: "0.0.0.0",
			port: 8123,
			authenticationEnabled: false,
		});
		expect(message).toContain(PRODUCT_NAME);
		expect(message).toContain("0.0.0.0:8123");
		expect(message).toContain("no API key");
		// The key comes first: it is the remedy that also works in a container,
		// where binding loopback would cut off the published port.
		const key = message?.indexOf(
			`${COMMAND_NAME} --generate-api-key <name> --admin`,
		);
		const host = message?.indexOf("BETTER_CCFLARE_HOST=127.0.0.1");
		expect(key).toBeGreaterThan(-1);
		expect(host).toBeGreaterThan(key ?? Number.POSITIVE_INFINITY);
		expect(message).not.toContain("\n");
	});

	it("says it repeats when the port is limited where the router cannot see", () => {
		// A container port published on 127.0.0.1, or a firewall, leaves the
		// bind address unchanged, so the next start warns again. Say so, or an
		// operator who took that remedy reads the repeat as the fix failing.
		const message = openBindWarning({
			hostname: "0.0.0.0",
			port: 8080,
			authenticationEnabled: false,
		});
		const limit = message?.indexOf("put a firewall in front of it");
		const repeat = message?.indexOf(
			"cannot see a firewall or a container's port mapping",
		);
		expect(limit).toBeGreaterThan(-1);
		expect(repeat).toBeGreaterThan(limit ?? Number.POSITIVE_INFINITY);
		expect(message).toContain("until a key exists");
	});
});

describe("warnIfOpenBind", () => {
	function harness(
		hostname: string,
		isAuthenticationEnabled: () => Promise<boolean>,
	) {
		const warnings: string[] = [];
		let checks = 0;
		const run = warnIfOpenBind({
			hostname,
			port: 8080,
			isAuthenticationEnabled: () => {
				checks += 1;
				return isAuthenticationEnabled();
			},
			warn: (message) => warnings.push(message),
		});
		return { run, warnings, checks: () => checks };
	}

	it("warns once when bound beyond loopback with no key", async () => {
		const h = harness("0.0.0.0", async () => false);
		await h.run;
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]).toBe(
			openBindWarning({
				hostname: "0.0.0.0",
				port: 8080,
				authenticationEnabled: false,
			}) as string,
		);
	});

	it("says nothing when a key exists", async () => {
		const h = harness("0.0.0.0", async () => true);
		await h.run;
		expect(h.warnings).toEqual([]);
		expect(h.checks()).toBe(1);
	});

	it("skips the key lookup on a loopback bind", async () => {
		const h = harness("127.0.0.1", async () => false);
		await h.run;
		expect(h.warnings).toEqual([]);
		expect(h.checks()).toBe(0);
	});

	it("never rejects when the key lookup fails, and says the check did not run", async () => {
		const h = harness("0.0.0.0", async () => {
			throw new Error("database is locked");
		});
		await expect(h.run).resolves.toBeUndefined();
		expect(h.warnings).toHaveLength(1);
		expect(h.warnings[0]).toContain("0.0.0.0:8080");
		expect(h.warnings[0]).toContain("database is locked");
		expect(h.warnings[0]).not.toContain("no API key");
	});
});
