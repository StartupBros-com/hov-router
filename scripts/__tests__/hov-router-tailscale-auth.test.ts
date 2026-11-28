import { afterEach, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
	chmodSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from "node:fs";
import http from "node:http";
import net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { AuthService } from "../../packages/http-api/src/services/auth-service";
import { createTailscaleDashboardVerifier } from "../../packages/http-api/src/services/tailscale-dashboard-auth";
import { NodeCryptoUtils } from "@hov-router/types/api-key";
import { createGuard } from "../hov-router-guard.mjs";

const origin = "https://router.example.test";
const login = "operator@example.test";
const proof = "x-hov-router-tailscale-dashboard";
const identity = { "tailscale-user-login": login };
const cleanup: (() => unknown)[] = [];
afterEach(async () => {
	while (cleanup.length) await cleanup.pop()?.();
});
async function waitFor(check: () => boolean, label: string) {
	const deadline = Date.now() + 3_000;
	while (!check()) {
		if (Date.now() >= deadline)
			throw new Error(`Timed out waiting for ${label}`);
		await Bun.sleep(5);
	}
}
function directory() {
	const dir = mkdtempSync(join(tmpdir(), "router-tailnet-"));
	cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}
function start(env: Record<string, string>) {
	const child = spawn("node", ["scripts/hov-router-guard.mjs"], {
		env: {
			PATH: process.env.PATH,
			GUARD_PORT: "0",
			GUARD_HOST: "127.0.0.1",
			...env,
		},
		stdio: ["ignore", "pipe", "pipe"],
	});
	const exited = new Promise((resolve) => child.once("exit", resolve));
	cleanup.push(async () => {
		if (child.exitCode === null && child.signalCode === null)
			child.kill("SIGKILL");
		await exited;
	});
	let log = "";
	child.stderr.on("data", (chunk) => {
		log += chunk;
	});
	const port = new Promise<number>((resolve, reject) => {
		const timer = setTimeout(
			() => reject(new Error(`guard startup timed out: ${log}`)),
			3_000,
		);
		const fail = (error: Error) => {
			clearTimeout(timer);
			reject(error);
		};
		child.once("error", fail);
		createInterface({ input: child.stdout }).on("line", (line) => {
			log += line;
			try {
				const entry = JSON.parse(line);
				if (entry.event === "guard_started") {
					clearTimeout(timer);
					resolve(entry.listenPort);
				}
			} catch (error) {
				fail(error instanceof Error ? error : new Error(String(error)));
			}
		});
		child.once("exit", (code) =>
			fail(new Error(`guard exited ${code}: ${log}`)),
		);
	});
	return { port, exited, child, log: () => log };
}
function config(socket: string, secret = randomBytes(32)) {
	return {
		HOV_ROUTER_TAILSCALE_SOCKET: socket,
		HOV_ROUTER_TAILSCALE_ORIGIN: origin,
		HOV_ROUTER_TAILSCALE_USERS: login,
		HOV_ROUTER_GUARD_CORRELATION_SECRET: secret.toString("base64url"),
	};
}
function send(
	target: number | string,
	path: string,
	headers: Record<string, string | string[]> = {},
	method = "GET",
) {
	return new Promise<{
		status: number;
		headers: http.IncomingHttpHeaders;
		body: string;
	}>((resolve, reject) => {
		const req = http.request(
			{
				...(typeof target === "number"
					? { host: "127.0.0.1", port: target }
					: { socketPath: target }),
				path,
				headers,
				method,
			},
			(res) => {
				let body = "";
				res.on("data", (chunk) => {
					body += chunk;
				});
				res.on("error", reject);
				res.on("end", () => {
					if (res.statusCode === undefined)
						return reject(new Error("missing HTTP status"));
					resolve({ status: res.statusCode, headers: res.headers, body });
				});
			},
		);
		req.on("error", reject);
		req.setTimeout(3_000, () => req.destroy(new Error("request timed out")));
		req.end();
	});
}

test("only private keyless dashboard requests carry an accepted proof", async () => {
	const socket = `${directory()}/serve.sock`;
	const secret = randomBytes(32);
	const key = "fixture-client-key";
	const record = {
		id: "fixture",
		role: "api-only",
		isActive: true,
		hashedKey: await new NodeCryptoUtils().hashApiKey(key),
		prefixLast8: key.slice(-8),
	};
	const auth = new AuthService(
		{
			countActiveApiKeys: async () => 1,
			getActiveApiKeys: async () => [record],
			updateApiKeyUsage: async () => {},
		} as never,
		undefined,
		undefined,
		createTailscaleDashboardVerifier(secret),
	);
	let seen = 0;
	const backend = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(req) {
			seen++;
			const path = new URL(req.url).pathname;
			const result =
				path === "/v1/messages" ||
				path === "/unmatched" ||
				path === "/api/unmatched"
					? await auth.authenticateProxyRequest(req, path, req.method)
					: await auth.authenticateRequest(req, path, req.method);
			const authorized =
				result.isAuthenticated &&
				(!result.role ||
					(
						await auth.authorizeEndpoint(
							{ role: result.role },
							path,
							req.method,
						)
					).authorized);
			return Response.json(
				{
					signed: req.headers.has(proof),
					raw: [...req.headers.keys()].some((k) => k.startsWith("tailscale-")),
					identity: result.dashboardIdentity?.login === login,
					role: result.role,
				},
				{
					status: authorized ? 200 : 401,
					headers: { [proof]: "private", "Tailscale-Other": "private" },
				},
			);
		},
	});
	cleanup.push(() => backend.stop(true));
	const guard = start({
		...config(socket, secret),
		HOV_ROUTER_UPSTREAM: backend.url.origin,
	});
	const port = await guard.port;
	const path = "/api/accounts";
	const allowed = await send(socket, path, identity);
	expect(allowed.status).toBe(200);
	expect(JSON.parse(allowed.body)).toEqual({
		signed: true,
		raw: false,
		identity: true,
		role: "admin",
	});
	expect(statSync(socket).mode & 0o777).toBe(0o600);
	expect(allowed.headers[proof]).toBeUndefined();
	expect(allowed.headers["tailscale-other"]).toBeUndefined();
	const ordinary = await send(port, path, {
		...identity,
		[proof]: "untrusted",
		"tailscale-extra": "untrusted",
		host: "localhost",
		"x-forwarded-host": new URL(origin).host,
	});
	expect(ordinary.status).toBe(401);
	expect(JSON.parse(ordinary.body)).toMatchObject({
		raw: false,
		signed: false,
	});
	const before = seen;
	const siblingImage = await send(socket, "/api/debug/snapshot", {
		...identity,
		"sec-fetch-site": "same-site",
		"sec-fetch-mode": "no-cors",
		"sec-fetch-dest": "image",
	});
	expect(siblingImage.status).toBe(403);
	expect(seen).toBe(before);
	for (const headers of [
		{},
		{ "tailscale-user-login": "other" },
		{ "tailscale-user-login": [login, login] },
		{ ...identity, "tailscale-funnel-request": "" },
		{ ...identity, origin: "https://other.test" },
		{ ...identity, "sec-fetch-site": "cross-site" },
	]) {
		expect(
			(await send(socket, path, headers as Record<string, string | string[]>))
				.status,
		).toBe(403);
	}
	expect((await send(socket, path, identity, "POST")).status).toBe(403);
	expect(seen).toBe(before);
	expect(
		(await send(socket, path, { ...identity, origin }, "POST")).status,
	).toBe(200);
	for (const headers of [
		{ "x-api-key": key },
		{ authorization: `Bearer ${key}` },
	]) {
		const response = await send(socket, path, {
			...identity,
			...headers,
		} as Record<string, string>);
		expect(response.status).toBe(401);
		expect(JSON.parse(response.body)).toMatchObject({
			signed: false,
			role: "api-only",
			identity: false,
		});
	}
	const invalid = await send(socket, path, {
		...identity,
		authorization: "Bearer invalid",
	});
	expect(invalid.status).toBe(401);
	expect(JSON.parse(invalid.body)).toMatchObject({
		signed: false,
		identity: false,
	});
	const machine = await send(
		socket,
		"/v1/messages",
		{ "x-api-key": key },
		"POST",
	);
	expect(machine.status).toBe(200);
	expect(JSON.parse(machine.body)).toMatchObject({
		signed: false,
		role: "api-only",
		identity: false,
	});
	for (const route of ["/v1/messages", "/unmatched", "/api/unmatched"]) {
		const reply = await send(socket, route, identity);
		expect(reply.status).toBe(401);
		if (!route.startsWith("/api/"))
			expect(JSON.parse(reply.body).signed).toBe(false);
	}
	for (const audience of ["logs", "requests", "alerts"] as const) {
		const stream = () =>
			`/api/${audience}/stream?stream_token=${auth.mintStreamToken(audience)}`;
		expect((await send(socket, stream(), identity)).status).toBe(200);
		expect((await send(port, stream(), identity)).status).toBe(401);
	}
	expect((await send(socket, "/_guard/health", identity)).body).not.toContain(
		login,
	);
	expect(guard.log()).not.toContain(login);
});

test("a private request waiting across handoff is signed with the replacement credential", async () => {
	const socket = `${directory()}/serve.sock`;
	const firstSecret = randomBytes(32);
	const nextSecret = randomBytes(32);
	const firstVerifier = createTailscaleDashboardVerifier(firstSecret);
	let verify = firstVerifier;
	let acceptedByOldKey = false;
	const backend = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			acceptedByOldKey = firstVerifier(req) !== null;
			return new Response("checked", { status: verify(req) ? 200 : 401 });
		},
	});
	cleanup.push(() => backend.stop(true));
	const replacement = {
		pid: process.pid,
		startTime: "1",
		sha256: "a".repeat(64),
	};
	const guard = createGuard({
		env: config(socket, firstSecret),
		listenPort: 0,
		upstreamBase: backend.url.origin,
		lifecycleEnabled: true,
		verifyReplacement: async () => replacement,
		logger: () => {},
	});
	await guard.listen();
	cleanup.push(() => guard.shutdown("fixture"));
	expect((await send(socket, "/api/accounts", identity)).status).toBe(200);
	expect(acceptedByOldKey).toBe(true);
	expect(guard.recycle.fence(1).ok).toBe(true);
	const waiting = send(socket, "/api/accounts", identity);
	await waitFor(
		() => guard.state.lifecycle.waiting === 1,
		"private request at handoff barrier",
	);
	verify = createTailscaleDashboardVerifier(nextSecret);
	expect(
		(
			await guard.recycle.attach({
				generation: 2,
				...replacement,
				correlationSecret: nextSecret.toString("base64url"),
			})
		).ok,
	).toBe(true);
	expect((await waiting).status).toBe(200);
	expect(acceptedByOldKey).toBe(false);
	expect((await send(socket, "/api/accounts", identity)).status).toBe(200);
});

test("refuses incomplete or unsafe configuration without removing an existing target", async () => {
	const dir = directory();
	const socket = `${dir}/serve.sock`;
	const good = config(socket);
	for (const patch of [
		{ HOV_ROUTER_TAILSCALE_ORIGIN: "" },
		{ HOV_ROUTER_TAILSCALE_SOCKET: "relative" },
		{ HOV_ROUTER_TAILSCALE_USERS: "a, b" },
		{ HOV_ROUTER_TAILSCALE_ORIGIN: origin + "/" },
		{ HOV_ROUTER_GUARD_CORRELATION_SECRET: "invalid" },
	]) {
		await expect(start({ ...good, ...patch }).port).rejects.toThrow(
			"guard exited 1",
		);
	}
	chmodSync(dir, 0o755);
	await expect(start(good).port).rejects.toThrow("guard exited 1");
	chmodSync(dir, 0o700);
	writeFileSync(socket, "operator file");
	await expect(start(good).port).rejects.toThrow("guard exited 1");
	expect(readFileSync(socket, "utf8")).toBe("operator file");
});

test("a failed TCP bind removes the private socket opened during startup", async () => {
	const socket = `${directory()}/serve.sock`;
	const occupied = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => new Response(),
	});
	cleanup.push(() => occupied.stop(true));
	const guard = start({ ...config(socket), GUARD_PORT: String(occupied.port) });
	await expect(guard.port).rejects.toThrow("EADDRINUSE");
	expect(existsSync(socket)).toBe(false);
});

test("empty configuration starts only the ordinary listener", async () => {
	const guard = start({
		HOV_ROUTER_TAILSCALE_SOCKET: "",
		HOV_ROUTER_TAILSCALE_ORIGIN: "",
		HOV_ROUTER_TAILSCALE_USERS: "",
	});
	expect((await send(await guard.port, "/_guard/health")).status).toBe(200);
});

test("SIGTERM waits for pending requests from both listeners", async () => {
	const socket = `${directory()}/serve.sock`;
	const pending = new Map<string, (r: Response) => void>();
	const backend = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(req) {
			return new Promise<Response>((resolve) => {
				pending.set(new URL(req.url).pathname, resolve);
			});
		},
	});
	cleanup.push(() => backend.stop(true));
	const guard = start({
		...config(socket),
		HOV_ROUTER_UPSTREAM: backend.url.origin,
	});
	function pipeline(target: net.NetConnectOpts, path: string) {
		const conn = net.connect(target, () =>
			conn.write(`GET ${path} HTTP/1.1\r\nHost: localhost\r\n\r\n`),
		);
		cleanup.push(() => conn.destroy());
		const reply = new Promise<string>((resolve, reject) => {
			let data = "";
			conn.on("data", (chunk) => {
				data += chunk;
			});
			conn.once("error", reject);
			conn.once("end", () => resolve(data));
		});
		return { conn, reply };
	}
	const tcp = pipeline({ host: "127.0.0.1", port: await guard.port }, "/tcp");
	const unix = pipeline({ path: socket }, "/unix");
	await waitFor(() => pending.size === 2, "both requests reaching the backend");
	guard.child.kill("SIGTERM");
	await waitFor(
		() => guard.log().includes('"guard_shutdown"'),
		"guard shutdown",
	);
	for (const { conn } of [tcp, unix])
		conn.write(
			"GET /late HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
		);
	await waitFor(
		() => guard.log().split('"guard_draining"').length >= 3,
		"both listeners draining",
	);
	for (const [path, client] of [
		["/tcp", tcp],
		["/unix", unix],
	] as const) {
		const complete = pending.get(path);
		if (!complete) throw new Error(`missing pending request: ${path}`);
		complete(new Response("finished"));
		const response = await client.reply;
		expect(response).toContain("finished");
		expect(response).toContain("503 Service Unavailable");
	}
	expect(pending.has("/late")).toBe(false);
	expect(await guard.exited).toBe(0);
	expect(existsSync(socket)).toBe(false);
});
