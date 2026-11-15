const STORAGE_FULL_CODES = new Set(["ENOSPC", "EDQUOT", "SQLITE_FULL"]);

/** SQLite's text for SQLITE_FULL, which survives a rethrow that drops the code. */
const SQLITE_FULL_MESSAGE = "database or disk is full";

/** How far down a `cause` chain to look. Real chains are two or three deep. */
const MAX_CAUSE_DEPTH = 8;

/**
 * True when an error says the filesystem, or the caller's quota on it, has no
 * room left: Node's `ENOSPC` and `EDQUOT`, or SQLite's `SQLITE_FULL`, at any
 * depth of the `cause` chain.
 *
 * Callers use this to keep running without a write they can do without
 * (#827), so it is deliberately narrow. `SQLITE_IOERR_*` and `EIO` are left
 * out even though a full disk can raise some of them: they also report a
 * failing device, and code that tolerates "full" must not tolerate that.
 */
export function isStorageFullError(error: unknown): boolean {
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (typeof current !== "object" || current === null) return false;
		const { code, message, cause } = current as {
			code?: unknown;
			message?: unknown;
			cause?: unknown;
		};
		if (typeof code === "string" && STORAGE_FULL_CODES.has(code)) return true;
		if (typeof message === "string" && message.includes(SQLITE_FULL_MESSAGE)) {
			return true;
		}
		current = cause;
	}
	return false;
}

const ERROR_CODE = /^[A-Z][A-Z0-9_]{0,63}$/;
const ERROR_NAME = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

function codeOrNameOf(error: unknown): string | null {
	let name: string | null = null;
	let current = error;
	for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
		if (typeof current !== "object" || current === null) break;
		const { code, cause } = current as { code?: unknown; cause?: unknown };
		if (typeof code === "string" && ERROR_CODE.test(code)) return code;
		if (depth === 0) {
			const own = (current as { name?: unknown }).name;
			if (typeof own === "string" && ERROR_NAME.test(own)) name = own;
		}
		current = cause;
	}
	if (isStorageFullError(error)) return "SQLITE_FULL";
	return name;
}

/**
 * A short label for an error, for places that must not show its message: the
 * first `code` in the `cause` chain that is an upper-case identifier
 * (`ENOSPC`, `SQLITE_FULL`), else the error's own name (`TypeError`).
 *
 * A message can hold a path, a statement or a token, and `/health` needs no
 * API key (#827). A code or a name holds none of those, and anything shaped
 * otherwise is not passed on. Never throws.
 */
export function errorKind(error: unknown): string {
	if (typeof error !== "object" || error === null) return "unknown";
	try {
		return codeOrNameOf(error) ?? "Error";
	} catch {
		return "unknown";
	}
}
