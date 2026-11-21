import { expect, test } from "bun:test";
import {
	HISTORICAL_WSTACK_RELEASE,
	isHistoricalWstackRelease,
	isRouterOwner,
	isRouterRepository,
	ROUTER_OWNERS,
	ROUTER_REPOSITORIES,
	ROUTER_REPOSITORY_ID,
	type RouterOwner,
	type RouterRepository,
	routerRepositoryOrigins,
	validateRouterRepository,
} from "./router-repository";

test("Router authority is one name per owner and one numeric ID", () => {
	// The personal account and the organization it moved to on 2026-11-20
	// (#911); a transfer keeps the numeric ID.
	expect(ROUTER_OWNERS).toEqual(["StartupBros", "StartupBros-com"]);
	expect(ROUTER_REPOSITORIES).toEqual([
		"StartupBros/hov-router",
		"StartupBros-com/hov-router",
	]);
	expect(ROUTER_REPOSITORY_ID).toBe(1278801682);
	for (const login of ["startupbros", "startupbros-com", "tombii", "", null])
		expect(isRouterOwner(login)).toBe(false);
	for (const full_name of ROUTER_REPOSITORIES) {
		const login = full_name.split("/")[0] as RouterOwner;
		const otherOwner = ROUTER_OWNERS.find((owner) => owner !== login);
		const metadata: RouterRepository = {
			id: 1278801682,
			full_name,
			name: "hov-router",
			owner: { login },
		};
		expect(isRouterOwner(login)).toBe(true);
		expect(isRouterRepository(full_name)).toBe(true);
		expect(validateRouterRepository(metadata)).toEqual(metadata);
		for (const patch of [
			{ id: undefined },
			{ id: 1 },
			{ id: "1278801682" },
			{ id: NaN },
			{ owner: undefined },
			{ owner: { login: login.toLowerCase() } },
			// Each name binds its own owner: the other accepted owner is refused.
			{ owner: { login: otherOwner } },
			{ name: "unrelated" },
			{ name: [metadata.name] },
			{ full_name: `other/${metadata.name}` },
			{ full_name: `${full_name}-extra` },
			{ full_name: `${full_name}/extra` },
			{ full_name: `prefix-${full_name}` },
			{ full_name: ` ${full_name}` },
			{ full_name: `${full_name}\n` },
		])
			expect(() =>
				validateRouterRepository({ ...metadata, ...patch }),
			).toThrow();
	}
	for (const metadata of [undefined, null, "StartupBros/hov-router", {}, []])
		expect(() => validateRouterRepository(metadata)).toThrow();
	// GitHub reports the current name for this repository ID, so the pre-rename
	// name is no longer a release authority.
	expect(isRouterRepository("StartupBros/wstack-router")).toBe(false);
	expect(() =>
		validateRouterRepository({
			id: 1278801682,
			full_name: "StartupBros/wstack-router",
			name: "wstack-router",
			owner: { login: "StartupBros" },
		}),
	).toThrow();
	for (const full_name of [
		"StartupBros-com/wstack-router",
		"StartupBros-com/better-ccflare",
	]) {
		expect(isRouterRepository(full_name)).toBe(false);
		expect(() =>
			validateRouterRepository({
				id: 1278801682,
				full_name,
				name: full_name.split("/")[1],
				owner: { login: "StartupBros-com" },
			}),
		).toThrow();
	}
});

test("the former name survives only as the pinned v3.6.2 release identity", () => {
	expect(HISTORICAL_WSTACK_RELEASE).toEqual({
		repository: "StartupBros/wstack-router",
		version: "3.6.2",
		ref: "refs/tags/v3.6.2",
		sha: "5d7b2a888a9b61d87916332b414e46606498d896",
	});
	expect(Object.isFrozen(HISTORICAL_WSTACK_RELEASE)).toBe(true);
	expect(isHistoricalWstackRelease({ ...HISTORICAL_WSTACK_RELEASE })).toBe(
		true,
	);
	for (const patch of [
		{ repository: "StartupBros/hov-router" },
		{ repository: undefined },
		{ version: "3.6.3" },
		{ ref: "refs/tags/v3.6.3" },
		{ ref: undefined },
		{ sha: "a".repeat(40) },
		{ sha: undefined },
	])
		expect(
			isHistoricalWstackRelease({ ...HISTORICAL_WSTACK_RELEASE, ...patch }),
		).toBe(false);
});

test("offline origin forms are literal and never require remote ID discovery", () => {
	for (const name of ROUTER_REPOSITORIES) {
		expect(routerRepositoryOrigins(name)).toEqual([
			`https://github.com/${name}`,
			`https://github.com/${name}.git`,
			`git@github.com:${name}.git`,
			`ssh://git@github.com/${name}.git`,
		]);
	}
	for (const name of [
		"StartupBros/hov-router-extra",
		"StartupBros/hov-router/extra",
		"startupbros/hov-router",
		"startupbros-com/hov-router",
		"StartupBros-com/hov-router-extra",
		"StartupBros-com/wstack-router",
		"StartupBros/wstack-router",
		"StartupBros/wstack-router.git",
		"other/hov-router",
	]) {
		expect(isRouterRepository(name)).toBe(false);
		expect(() => routerRepositoryOrigins(name)).toThrow();
	}
});
