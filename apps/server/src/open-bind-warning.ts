import { isLoopbackHost } from "@hov-router/core";
import { COMMAND_NAME, PRODUCT_NAME } from "@hov-router/core/product-identity";

/**
 * Whether the listening address is provably loopback only. Anything else
 * (`0.0.0.0`, `::`, a LAN address, a name that is not `localhost`) is treated
 * as reachable from other machines, because a missed warning costs more than
 * a spurious one.
 */
export function isLoopbackBind(hostname: string): boolean {
	return isLoopbackHost(hostname.trim().toLowerCase());
}

export interface OpenBindState {
	hostname: string;
	port: number;
	/** `AuthService.isAuthenticationEnabled()`: at least one active API key. */
	authenticationEnabled: boolean;
}

/**
 * The startup warning for a router that other machines can reach while it
 * holds no API key, or `null` when there is nothing to warn about.
 *
 * API-key authentication stays off until the first key is created, so in that
 * state every proxy and API request is accepted. The key is named first: it
 * also works in a container, where binding loopback would cut off the
 * published port.
 */
export function openBindWarning(state: OpenBindState): string | null {
	if (state.authenticationEnabled || isLoopbackBind(state.hostname)) {
		return null;
	}
	return (
		`${PRODUCT_NAME} is listening on ${state.hostname}:${state.port} with no API key, ` +
		"so anyone who can reach this port can use the accounts it holds and change its settings. " +
		`Create an admin key with \`${COMMAND_NAME} --generate-api-key <name> --admin\` or on the dashboard's API Keys page. ` +
		"Or limit who can reach the port: set BETTER_CCFLARE_HOST=127.0.0.1 when clients run on this machine, " +
		"publish a container port on 127.0.0.1 only, or put a firewall in front of it. " +
		`${PRODUCT_NAME} cannot see a firewall or a container's port mapping, so this warning repeats until a key exists or the host is a loopback address.`
	);
}

export interface OpenBindCheck {
	hostname: string;
	port: number;
	isAuthenticationEnabled: () => Promise<boolean>;
	warn: (message: string) => void;
}

/**
 * Logs {@link openBindWarning} once at startup. Asks the same question the
 * request path asks, so the warning cannot disagree with what is enforced.
 * Never rejects: a failed key lookup is reported and startup carries on.
 */
export async function warnIfOpenBind(check: OpenBindCheck): Promise<void> {
	if (isLoopbackBind(check.hostname)) return;
	let authenticationEnabled: boolean;
	try {
		authenticationEnabled = await check.isAuthenticationEnabled();
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		check.warn(
			`${PRODUCT_NAME} is listening on ${check.hostname}:${check.port} and could not check whether an API key exists: ${reason}`,
		);
		return;
	}
	const message = openBindWarning({
		hostname: check.hostname,
		port: check.port,
		authenticationEnabled,
	});
	if (message) check.warn(message);
}
