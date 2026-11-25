import { errorResponse, ServiceUnavailable } from "@better-ccflare/http-common";
import {
	createLastGoodCache,
	type LastGoodCacheOptions,
} from "./last-good-cache";

export interface LastGoodResponseOptions extends LastGoodCacheOptions {
	/** How long a request with nothing to fall back on waits. */
	waitMs: number;
	/** How long a request waits when an earlier body can answer. */
	staleWaitMs: number;
	/** The 503 message when nothing usable arrives within `waitMs`. */
	busyMessage: string;
}

interface StoredResponse {
	body: string;
	headers: Array<[string, string]>;
}

/** A non-200 response, carried out of the cache load so it is never stored. */
class UncachedResponse extends Error {
	constructor(
		readonly status: number,
		readonly stored: StoredResponse,
	) {
		super(`response status ${status}`);
	}
}

async function store(response: Response): Promise<StoredResponse> {
	return { body: await response.text(), headers: [...response.headers] };
}

function rebuild(
	stored: StoredResponse,
	status: number,
	extra: Record<string, string> = {},
): Response {
	const headers = new Headers(stored.headers);
	for (const [name, value] of Object.entries(extra)) headers.set(name, value);
	return new Response(stored.body, { status, headers });
}

/** Path plus query with parameters sorted, so their order does not split the cache. */
export function lastGoodResponseKey(url: URL): string {
	const params = [...url.searchParams].sort(([a], [b]) =>
		a < b ? -1 : a > b ? 1 : 0,
	);
	return `${url.pathname}?${new URLSearchParams(params)}`;
}

/**
 * Last-good cache over whole GET responses (#1013): one computation per key
 * at a time, a 200 body reused while fresh and served with an `Age` header
 * while a recomputation is slow, a 503 when there is nothing to serve in
 * time. Non-200 responses go back to their own caller and are not stored.
 * Each caller gets a new Response, since a body can be read only once.
 */
export function createLastGoodResponses(options: LastGoodResponseOptions) {
	const now = options.now ?? Date.now;
	const cache = createLastGoodCache<StoredResponse>(options);
	return {
		async respond(
			key: string,
			compute: () => Promise<Response>,
		): Promise<Response> {
			try {
				const hit = await cache.get(
					key,
					async () => {
						const response = await compute();
						const stored = await store(response);
						if (response.status !== 200)
							throw new UncachedResponse(response.status, stored);
						return stored;
					},
					{ waitMs: options.waitMs, staleWaitMs: options.staleWaitMs },
				);
				if (!hit) return errorResponse(ServiceUnavailable(options.busyMessage));
				return hit.fresh
					? rebuild(hit.value, 200)
					: rebuild(hit.value, 200, {
							Age: String(Math.max(0, Math.floor((now() - hit.asOf) / 1000))),
						});
			} catch (error) {
				if (error instanceof UncachedResponse)
					return rebuild(error.stored, error.status);
				throw error;
			}
		},
		clear: cache.clear,
	};
}

export type LastGoodResponses = ReturnType<typeof createLastGoodResponses>;
