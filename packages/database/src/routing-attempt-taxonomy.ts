export {
	ROUTING_ATTEMPT_REASONS,
	ROUTING_ATTEMPT_SCOPES,
	type RoutingAttemptReason,
	type RoutingAttemptScope,
} from "@hov-router/types";

import { ROUTING_ATTEMPT_REASONS } from "@hov-router/types";

export const ROUTING_ATTEMPT_REASON_SQL = ROUTING_ATTEMPT_REASONS.map(
	(reason) => `'${reason}'`,
).join(", ");
