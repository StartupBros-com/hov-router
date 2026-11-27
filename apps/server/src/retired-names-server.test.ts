import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// 8.0.0 reads only the HoV Router names. The real server must refuse the
// names it inherited from better-ccflare rather than fall back to defaults.

const dirs: string[] = [];
afterEach(() => {
	for (const dir of dirs.splice(0))
		rmSync(dir, { recursive: true, force: true });
});

function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "hov-retired-server-"));
	dirs.push(dir);
	return dir;
}

function freePort(): number {
	const reservation = Bun.serve({
		port: 0,
		hostname: "127.0.0.1",
		fetch: () => new Response(),
	});
	const port = reservation.port;
	reservation.stop(true);
	if (port === undefined) throw new Error("TCP reservation has no port");
	return port;
}

function startServer(dir: string, port: number, env: Record<string, string>) {
	return Bun.spawn(
		[
			process.execPath,
			"run",
			"apps/server/src/server.ts",
			"--port",
			String(port),
		],
		{
			env: {
				...process.env,
				HOME: dir,
				XDG_CONFIG_HOME: dir,
				HOV_ROUTER_HOST: "127.0.0.1",
				HOV_ROUTER_DB_PATH: join(dir, "test.db"),
				...env,
			},
			stdout: "pipe",
			stderr: "pipe",
		},
	);
}

test("exits 78 and names the replacement for an old environment name", async () => {
	const dir = scratch();
	const child = startServer(dir, freePort(), {
		BETTER_CCFLARE_DB_PATH: "retired-value-must-not-print",
	});
	const stderr = new Response(child.stderr).text();
	expect(await child.exited).toBe(78);
	const output = await stderr;
	expect(output).toContain("BETTER_CCFLARE_DB_PATH -> HOV_ROUTER_DB_PATH");
	expect(output).not.toContain("retired-value-must-not-print");
}, 30000);

test("exits 78 when the old config directory was never moved", async () => {
	const dir = scratch();
	mkdirSync(join(dir, "better-ccflare"));
	const child = startServer(dir, freePort(), {});
	const stderr = new Response(child.stderr).text();
	expect(await child.exited).toBe(78);
	expect(await stderr).toContain(
		`${join(dir, "better-ccflare")} -> ${join(dir, "hov-router")}`,
	);
}, 30000);

test("answers an old request header with 400 before routing", async () => {
	const dir = scratch();
	const port = freePort();
	const child = startServer(dir, port, {});
	const out = new Response(child.stdout).text();
	const err = new Response(child.stderr).text();
	try {
		const deadline = Date.now() + 25000;
		let ready = false;
		while (!ready && Date.now() < deadline) {
			try {
				// Any answer means it is listening; /health is 503 with no accounts.
				await fetch(`http://127.0.0.1:${port}/health`);
				ready = true;
			} catch {
				await Bun.sleep(100);
			}
		}
		expect(ready).toBe(true);

		const response = await fetch(`http://127.0.0.1:${port}/v1/messages`, {
			method: "POST",
			headers: {
				"content-type": "application/json",
				"x-better-ccflare-account-id": "00000000-0000-4000-8000-000000000001",
			},
			body: "{}",
		});
		expect(response.status).toBe(400);
		const body = (await response.json()) as {
			error: { type: string; message: string };
		};
		expect(body.error.type).toBe("invalid_request_error");
		expect(body.error.message).toContain(
			"x-better-ccflare-account-id was renamed to x-hov-router-account-id",
		);
	} finally {
		child.kill("SIGTERM");
		await child.exited;
		await out;
		await err;
	}
}, 35000);
