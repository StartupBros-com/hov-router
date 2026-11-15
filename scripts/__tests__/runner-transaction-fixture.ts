/**
 * The runner (scripts/run-ccflare-stack.sh) started the way the unit starts
 * it: with the deployment transaction on, the repo's own guard and
 * transaction module, and cwd "/". Only the backend is a stub. It answers
 * /health and exits when a test tells it to.
 *
 * Used by the runner's full-disk tests, and by the driver those tests run on a
 * filesystem with no free block, so nothing here may assume there is space
 * under `state` or `tmp`. What the stub and the wrapper record goes to
 * `scratch`, which is never on the filesystem under test.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
	chmodSync,
	existsSync,
	mkdirSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { resolveNodeExecutable } from "./node-runtime";

export const repoRoot = join(import.meta.dir, "..", "..");
export const transactionModule = join(
	repoRoot,
	"scripts",
	"ccflare-deployment-transaction.mjs",
);
const runnerScript = join(repoRoot, "scripts", "run-ccflare-stack.sh");

export interface RunnerLayout {
	/** The stub programs and what they record. Never on the filesystem under test. */
	scratch: string;
	/** HOME, the handoff directory and the pin file. */
	state: string;
	/** The runner's TMPDIR. Not made here: a test may want it missing. */
	tmp: string;
	/** What systemd would pass as RUNTIME_DIRECTORY. Left unset when absent. */
	runtimeDirectory?: string;
}

export interface RunnerFixture {
	child: ChildProcess;
	/** Where the stub backend and the node wrapper write what they did. */
	capture: string;
	handoff: string;
	guardPort: number;
	/** Everything the runner and its children printed, stdout and stderr. */
	output(): string;
	/** How many times `needle` appears in the output. */
	count(needle: string): number;
	/** Resolves once `needle` has appeared `times` times; throws if the runner exits first. */
	waitForOutput(
		needle: string,
		options?: { times?: number; timeoutMs?: number },
	): Promise<void>;
	/** Make the running backend exit with `status`. */
	crashBackend(status?: number): void;
	/**
	 * While set, every backend the runner starts exits with `status` a moment
	 * after it starts, before it listens. `null` lets backends start again.
	 */
	refuseBackendStart(status: number | null): void;
	/**
	 * While set, the transaction command `command` exits with `status` without
	 * running. `null` lets it run again.
	 */
	refuseCommand(command: string, status: number | null): void;
	/**
	 * While set, the transaction command `command` runs and then waits before
	 * it returns, so the runner is still inside that call. `false` lets it
	 * return. Set it before the runner gets to the command.
	 */
	holdCommand(command: string, hold: boolean): void;
	/** Resolves once a held `command` has run and is waiting to return. */
	waitForHeld(command: string, timeoutMs?: number): Promise<void>;
	exited(): { code: number | null; signal: NodeJS.Signals | null } | null;
	waitForExit(
		timeoutMs?: number,
	): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** SIGTERM, then the exit. */
	stop(
		timeoutMs?: number,
	): Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
	/** What the transaction module's `recover` says about the handoff directory. */
	recover(): { status: number | null; stdout: string; stderr: string };
	/** Kill the runner and everything it started. For a test that failed. */
	destroy(): void;
}

async function allocatePorts(count: number): Promise<number[]> {
	const servers = Array.from({ length: count }, () => createServer());
	await Promise.all(
		servers.map(
			(server) =>
				new Promise<void>((resolve, reject) => {
					server.once("error", reject);
					server.listen(0, "127.0.0.1", resolve);
				}),
		),
	);
	const ports = servers.map((server) => {
		const address = server.address();
		if (!address || typeof address === "string")
			throw new Error("failed to allocate a fixture port");
		return address.port;
	});
	await Promise.all(
		servers.map(
			(server) => new Promise<void>((resolve) => server.close(() => resolve())),
		),
	);
	return ports;
}

/**
 * Processes other than this one whose command line or environment names
 * `needle`. Every process of a fixture has its scratch directory in one or
 * the other.
 */
export function processesNaming(needle: string): number[] {
	const found: number[] = [];
	for (const entry of readdirSync("/proc")) {
		const pid = Number(entry);
		if (!Number.isInteger(pid) || pid === process.pid) continue;
		for (const file of ["cmdline", "environ"]) {
			try {
				if (readFileSync(`/proc/${entry}/${file}`, "utf8").includes(needle)) {
					found.push(pid);
					break;
				}
			} catch {
				// Gone already, or not ours to read.
			}
		}
	}
	return found;
}

export async function startRunner(
	layout: RunnerLayout,
	extraEnv: Record<string, string> = {},
): Promise<RunnerFixture> {
	const node = resolveNodeExecutable();
	const capture = join(layout.scratch, "capture");
	const home = join(layout.state, "home");
	const handoff = join(layout.state, "handoff");
	const pin = join(layout.state, "pin");
	mkdirSync(capture, { recursive: true });
	mkdirSync(home, { recursive: true });
	if (!existsSync(pin)) writeFileSync(pin, "fixture-pin\n");

	// The runner sets its own PATH, so the stub names the Node it runs on.
	const backend = join(layout.scratch, "fake-backend.mjs");
	writeFileSync(
		backend,
		[
			`#!${node}`,
			'import { appendFileSync, existsSync, readFileSync, unlinkSync } from "node:fs";',
			'import http from "node:http";',
			'const port = Number(process.argv[process.argv.indexOf("--port") + 1]);',
			"const capture = process.env.CAPTURE_DIR;",
			"const note = (what) => appendFileSync(`${capture}/lifecycle.log`, `${what} ${process.pid}\\n`);",
			'const status = (file) => Number(readFileSync(file, "utf8").trim() || "1");',
			"const refusal = `${capture}/refuse-backend-start`;",
			"if (existsSync(refusal)) {",
			// Late enough for the runner to have read this process's identity.
			'  note("backend-refused");',
			"  setTimeout(() => process.exit(status(refusal)), 150);",
			"} else {",
			'  note("backend-start");',
			"  const server = http.createServer((_req, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{\"status\":\"ok\"}'); });",
			"  server.listen(port, '127.0.0.1');",
			"  const crash = `${capture}/crash-backend`;",
			"  setInterval(() => { if (!existsSync(crash)) return; const code = status(crash); try { unlinkSync(crash); } catch {} note('backend-crash'); process.exit(code); }, 20);",
			"  process.on('SIGTERM', () => { note('backend-term'); server.close(() => process.exit(0)); });",
			"}",
		].join("\n"),
	);
	chmodSync(backend, 0o755);

	// Stands in for NODE_BIN so that a test can make one transaction command
	// fail the way a full disk or a refused write would, or keep the runner
	// inside one for as long as the test needs.
	const nodeWrapper = join(layout.scratch, "node-wrapper.sh");
	writeFileSync(
		nodeWrapper,
		[
			"#!/usr/bin/env bash",
			'refusal="$CAPTURE_DIR/refuse-command-${2:-}"',
			'if [[ -n "${2:-}" && -f "$refusal" ]]; then',
			'	status="$(<"$refusal")"',
			'	printf \'%s\\n\' "$2" >>"$CAPTURE_DIR/refused-commands.log"',
			'	printf \'fixture: %s refused with status %s\\n\' "$2" "$status" >&2',
			'	exit "$status"',
			"fi",
			'hold="$CAPTURE_DIR/hold-command-${2:-}"',
			'if [[ -n "${2:-}" && -f "$hold" ]]; then',
			`	${JSON.stringify(node)} "$@"`,
			"	status=$?",
			'	: >"$CAPTURE_DIR/held-command-$2"',
			'	while [[ -f "$hold" ]]; do sleep 0.01; done',
			'	exit "$status"',
			"fi",
			`exec ${JSON.stringify(node)} "$@"`,
		].join("\n"),
	);
	chmodSync(nodeWrapper, 0o755);

	const [guardPort, upstreamPort] = await allocatePorts(2);
	const env: Record<string, string | undefined> = {
		...process.env,
		HOME: home,
		USER: "fixture",
		NODE_BIN: nodeWrapper,
		CCFLARE_BIN: backend,
		GUARD_SCRIPT: join(repoRoot, "scripts", "ccflare-guard.mjs"),
		GUARD_SOURCE_ID: "a".repeat(40),
		CCFLARE_SOURCE_SHA: "a".repeat(40),
		CCFLARE_GIT_SHA: "a".repeat(40),
		CCFLARE_SCHEMA_DIGEST: "c".repeat(64),
		CCFLARE_PIN_PATH: pin,
		CCFLARE_TRANSACTION_DIR: handoff,
		CCFLARE_UPSTREAM_PORT: String(upstreamPort),
		GUARD_PORT: String(guardPort),
		GUARD_TOTAL_DEADLINE_MS: "10000",
		GUARD_RETRY_ATTEMPT_HEADROOM_MS: "1",
		GUARD_MAX_RECOVERY_SLEEP_MS: "100",
		GUARD_SHUTDOWN_GRACE_MS: "10000",
		GUARD_SHUTDOWN_CUSHION_MS: "100",
		RUNNER_HEALTH_POLL_INTERVAL_MS: "10",
		RUNNER_HEALTH_MAX_ATTEMPTS: "1500",
		RUNNER_HEALTH_STABILITY_DELAY_MS: "0",
		RUNNER_FAILURE_STOP_BUDGET_MS: "5000",
		RUNNER_RESTART_BACKOFF_BASE_MS: "10",
		RUNNER_RESTART_BACKOFF_MAX_MS: "40",
		AI_GATEWAY_TUNNEL_ENABLED: "0",
		AI_GATEWAY_TUNNEL_REQUIRED: "0",
		TMPDIR: layout.tmp,
		CAPTURE_DIR: capture,
		// The unit's values, not whatever this test process happens to carry.
		INVOCATION_ID: undefined,
		RUNNER_PERSISTENT_GUARD: undefined,
		RUNNER_CIRCUIT_HOLD: undefined,
		LOG_LEVEL: undefined,
		CCFLARE_DEPLOYMENT_RUNTIME: undefined,
		RUNTIME_DIRECTORY: layout.runtimeDirectory,
		...extraEnv,
	};

	const child = spawn("bash", [runnerScript], {
		cwd: "/",
		env,
		stdio: ["ignore", "pipe", "pipe"],
		// Its own process group, so a failed test can take all of it down.
		detached: true,
	});
	let output = "";
	child.stdout?.on("data", (chunk) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk) => {
		output += chunk.toString();
	});
	let exit: { code: number | null; signal: NodeJS.Signals | null } | null =
		null;
	const exitPromise = new Promise<{
		code: number | null;
		signal: NodeJS.Signals | null;
	}>((resolve) => {
		child.once("exit", (code, signal) => {
			exit = { code, signal };
			resolve(exit);
		});
	});

	const count = (needle: string) => output.split(needle).length - 1;
	const control = (name: string, value: number | null) => {
		const path = join(capture, name);
		if (value === null) rmSync(path, { force: true });
		else writeFileSync(path, String(value));
	};
	const waitForExit = async (timeoutMs = 20_000) => {
		const result = await Promise.race([
			exitPromise,
			Bun.sleep(timeoutMs).then(() => null),
		]);
		if (!result)
			throw new Error(
				`the runner did not exit in ${timeoutMs} ms:\n${output.slice(-4000)}`,
			);
		return result;
	};

	return {
		child,
		capture,
		handoff,
		guardPort,
		output: () => output,
		count,
		async waitForOutput(needle, { times = 1, timeoutMs = 20_000 } = {}) {
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (count(needle) >= times) return;
				if (exit)
					throw new Error(
						`the runner exited (${JSON.stringify(exit)}) before '${needle}' appeared ${times} time(s):\n${output.slice(-4000)}`,
					);
				await Bun.sleep(10);
			}
			throw new Error(
				`'${needle}' did not appear ${times} time(s) in ${timeoutMs} ms:\n${output.slice(-4000)}`,
			);
		},
		crashBackend: (status = 1) => control("crash-backend", status),
		refuseBackendStart: (status) => control("refuse-backend-start", status),
		refuseCommand: (command, status) =>
			control(`refuse-command-${command}`, status),
		holdCommand: (command, hold) =>
			control(`hold-command-${command}`, hold ? 1 : null),
		async waitForHeld(command, timeoutMs = 20_000) {
			const held = join(capture, `held-command-${command}`);
			const deadline = Date.now() + timeoutMs;
			while (Date.now() < deadline) {
				if (existsSync(held)) return;
				if (exit)
					throw new Error(
						`the runner exited (${JSON.stringify(exit)}) before it was held in ${command}:\n${output.slice(-4000)}`,
					);
				await Bun.sleep(10);
			}
			throw new Error(
				`the runner was not held in ${command} in ${timeoutMs} ms:\n${output.slice(-4000)}`,
			);
		},
		exited: () => exit,
		waitForExit,
		async stop(timeoutMs = 20_000) {
			if (!exit) child.kill("SIGTERM");
			return waitForExit(timeoutMs);
		},
		recover() {
			const result = spawnSync(node, [transactionModule, "recover", handoff], {
				cwd: "/",
				env: { ...env, NODE_BIN: node } as NodeJS.ProcessEnv,
				encoding: "utf8",
				timeout: 15_000,
			});
			return {
				status: result.status,
				stdout: result.stdout.trim(),
				stderr: result.stderr.trim(),
			};
		},
		destroy() {
			if (child.pid === undefined) return;
			try {
				process.kill(-child.pid, "SIGKILL");
			} catch {
				// The group is gone already.
			}
		},
	};
}
