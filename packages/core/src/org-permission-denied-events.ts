import { EventEmitter } from "node:events";

/**
 * One Anthropic 403 `permission_error` refusing an account's organization
 * (rate-limit reason `org_permission_denied`), emitted by the proxy on every
 * refused attempt. The alert service turns the first one of a refusal episode
 * into an operator alert (#877). Lives in core, like auth-failure-events.ts,
 * because the proxy emits it and the HTTP API listens.
 */
export interface OrgPermissionDeniedEvt {
	accountId: string;
	accountName: string;
	provider: string;
	/** ms epoch when the proxy handled the refusal. */
	timestamp: number;
}

/**
 * One Anthropic usage check (`/api/oauth/usage`) and what it said about the
 * account's organization (#941), emitted by the usage cache as a "usage"
 * event on the same bus: `refused` for the 403 that refuses the
 * organization, `accepted` for a check that returned usage. An account
 * nobody routes to is still polled, so these let the alert service open a
 * refusal episode, and close one, without waiting for traffic.
 */
export interface OrgUsageCheckEvt {
	accountId: string;
	outcome: "refused" | "accepted";
	/** ms epoch when the usage check was sent. */
	startedAt: number;
	/** ms epoch when its answer arrived. */
	answeredAt: number;
}

class OrgPermissionDeniedEventBus extends EventEmitter {}
export const orgPermissionDeniedEvents = new OrgPermissionDeniedEventBus();

orgPermissionDeniedEvents.setMaxListeners(200);
