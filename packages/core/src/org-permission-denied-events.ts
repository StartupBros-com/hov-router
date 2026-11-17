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

class OrgPermissionDeniedEventBus extends EventEmitter {}
export const orgPermissionDeniedEvents = new OrgPermissionDeniedEventBus();

orgPermissionDeniedEvents.setMaxListeners(200);
