import { createHmac, timingSafeEqual } from "node:crypto";
import { TAILSCALE_DASHBOARD_HEADER } from "@hov-router/http-common";

const SIGNING_DOMAIN = "hov-router/tailscale-dashboard/v1";
const MAX_PROOF_AGE_MS = 30_000;
const MAX_CLOCK_SKEW_MS = 5_000;

export interface DashboardIdentity {
	provider: "tailscale";
	login: string;
}

export type DashboardIdentityVerifier = (
	req: Request,
) => DashboardIdentity | null;

/** Only the dedicated guard ingress can create this proof. Tailscale's raw
 * identity headers and the ordinary loopback peer address carry no authority. */
export function createTailscaleDashboardVerifier(
	secret: Uint8Array | undefined,
	now: () => number = Date.now,
): DashboardIdentityVerifier {
	const key = secret?.byteLength === 32 ? Buffer.from(secret) : undefined;
	return (req) => {
		if (!key) return null;
		const proof = req.headers.get(TAILSCALE_DASHBOARD_HEADER);
		if (!proof || proof.length > 4_096) return null;
		const [version, payload, signature, extra] = proof.split(".");
		if (version !== "v1" || !payload || !signature || extra !== undefined) {
			return null;
		}
		try {
			const actual = Buffer.from(signature, "base64url");
			if (actual.length !== 32 || actual.toString("base64url") !== signature) {
				return null;
			}
			const expected = createHmac("sha256", key)
				.update(`${SIGNING_DOMAIN}\n${payload}`)
				.digest();
			if (!timingSafeEqual(actual, expected)) return null;
			const bytes = Buffer.from(payload, "base64url");
			if (bytes.toString("base64url") !== payload) return null;
			const claim: unknown = JSON.parse(bytes.toString("utf8"));
			if (!claim || typeof claim !== "object" || Array.isArray(claim))
				return null;
			const { login, origin, method, path, issuedAt } = claim as Record<
				string,
				unknown
			>;
			if (
				typeof login !== "string" ||
				!login ||
				login.length > 320 ||
				/[^\x21-\x7e]/.test(login) ||
				login.includes(",") ||
				typeof origin !== "string" ||
				typeof path !== "string" ||
				typeof issuedAt !== "number" ||
				!Number.isSafeInteger(issuedAt) ||
				method !== req.method
			)
				return null;
			const expectedOrigin = new URL(origin);
			if (
				expectedOrigin.protocol !== "https:" ||
				expectedOrigin.origin !== origin
			)
				return null;
			const url = new URL(req.url);
			if (
				!url.pathname.startsWith("/api/") ||
				`${url.pathname}${url.search}` !== path
			)
				return null;
			const age = now() - issuedAt;
			if (age < -MAX_CLOCK_SKEW_MS || age > MAX_PROOF_AGE_MS) return null;
			const requestOrigin = req.headers.get("origin");
			if (requestOrigin !== null && requestOrigin !== origin) return null;
			if (!["GET", "HEAD"].includes(req.method) && requestOrigin !== origin)
				return null;
			if (req.headers.get("sec-fetch-site") === "cross-site") return null;
			return { provider: "tailscale", login };
		} catch {
			return null;
		}
	};
}
