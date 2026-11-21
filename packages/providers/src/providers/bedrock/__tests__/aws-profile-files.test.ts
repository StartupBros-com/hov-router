import { describe, expect, it } from "bun:test";
import {
	hasAwsCredentialsProfile,
	readAwsConfigRegion,
} from "../aws-profile-files";

const credentials = [
	"[default]",
	"aws_access_key_id = AKIADEFAULT",
	"",
	"[prodXeu]",
	"aws_access_key_id = AKIAPRODX",
	"",
	"[team(a]",
	"aws_access_key_id = AKIATEAM",
	"",
].join("\n");

const config = [
	"[default]",
	"region = us-east-1",
	"",
	"[profile prodXeu]",
	"region = ap-south-1",
	"",
	"[profile prod.eu]",
	"output = json",
	"region = eu-west-1 ",
	"",
	"[profile no-region]",
	"output = json",
	"",
	"[profile next]",
	"region = us-west-2",
	"",
].join("\n");

describe("hasAwsCredentialsProfile", () => {
	it("finds the default and named profiles", () => {
		expect(hasAwsCredentialsProfile(credentials, "default")).toBe(true);
		expect(hasAwsCredentialsProfile(credentials, "prodXeu")).toBe(true);
		expect(hasAwsCredentialsProfile(credentials, "missing")).toBe(false);
	});

	it("matches a profile name as literal text, never as a pattern", () => {
		// "prod.eu" built into a regex matched the "[prodXeu]" section.
		expect(hasAwsCredentialsProfile(credentials, "prod.eu")).toBe(false);
		expect(hasAwsCredentialsProfile(credentials, ".*")).toBe(false);
		// An unbalanced "(" made the regex throw, so a real profile read as missing.
		expect(hasAwsCredentialsProfile(credentials, "team(a")).toBe(true);
	});

	it("matches section headers only, not a prefix of a longer name", () => {
		expect(hasAwsCredentialsProfile(credentials, "prod")).toBe(false);
		expect(hasAwsCredentialsProfile("[prod] ; note\n", "prod")).toBe(true);
		expect(hasAwsCredentialsProfile("key = [prod]\n", "prod")).toBe(false);
	});

	it("reads files with Windows line endings", () => {
		expect(hasAwsCredentialsProfile("[a]\r\nk = v\r\n[b]\r\n", "b")).toBe(true);
	});
});

describe("readAwsConfigRegion", () => {
	it("reads the default section and named profile sections", () => {
		expect(readAwsConfigRegion(config, "default")).toBe("us-east-1");
		expect(readAwsConfigRegion(config, "prodXeu")).toBe("ap-south-1");
		expect(readAwsConfigRegion(config, "next")).toBe("us-west-2");
	});

	it("reads the named profile's own section, not one its name matches as a pattern", () => {
		// "prod.eu" built into a regex matched "[profile prodXeu]" first.
		expect(readAwsConfigRegion(config, "prod.eu")).toBe("eu-west-1");
		expect(readAwsConfigRegion(config, ".*")).toBeNull();
	});

	it("stops at the next section instead of taking its region", () => {
		expect(readAwsConfigRegion(config, "no-region")).toBeNull();
		expect(readAwsConfigRegion(config, "missing")).toBeNull();
	});

	it("reads files with Windows line endings", () => {
		expect(
			readAwsConfigRegion("[profile w]\r\nregion = eu-north-1\r\n", "w"),
		).toBe("eu-north-1");
	});

	it("keeps the region line's meaning without backtracking over its spaces", () => {
		expect(
			readAwsConfigRegion("[default]\nregion =\nregion=x\n", "default"),
		).toBe("x");
		expect(readAwsConfigRegion("[default]\nregion = \n", "default")).toBe("");
		// A lone "\r" ends what "." matches, so this line never holds a region.
		// With overlapping "\s*" and "(.+)" every split of the spaces was retried.
		const line = `region=${" ".repeat(80_000)}x\ry`;
		const started = performance.now();
		expect(readAwsConfigRegion(`[default]\n${line}\n`, "default")).toBeNull();
		expect(performance.now() - started).toBeLessThan(250);
	});
});
