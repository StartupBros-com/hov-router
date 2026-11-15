/**
 * Child process for storage-full-backstop.test.ts. Installs the backstop
 * (unless told not to), provokes one uncaught error with the real runtime,
 * and says whether it is still running a moment later.
 */
import { createWriteStream } from "node:fs";
import { installStorageFullBackstop } from "./storage-full-backstop";

const [provoke, mode] = process.argv.slice(2);
const backstop = mode === "no-backstop" ? null : installStorageFullBackstop();

switch (provoke) {
	case "stream-on-full-device":
		// No "error" listener, so the failed write is an uncaught exception.
		createWriteStream("/dev/full").write("x".repeat(70_000));
		break;
	case "reject-database-full":
		void Promise.reject(
			Object.assign(new Error("database or disk is full"), {
				code: "SQLITE_FULL",
			}),
		);
		break;
	case "throw-other":
		setTimeout(() => {
			throw new Error("not a storage problem");
		}, 0);
		break;
	case "reject-other":
		void Promise.reject(new Error("not a storage problem"));
		break;
	default:
		console.error(`unknown case: ${provoke}`);
		process.exit(2);
}

setTimeout(() => {
	console.log(
		JSON.stringify({ alive: true, status: backstop?.status() ?? null }),
	);
	process.exit(0);
}, 300);
