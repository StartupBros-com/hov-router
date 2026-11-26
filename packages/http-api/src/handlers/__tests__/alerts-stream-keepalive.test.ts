import { alertEvents } from "@hov-router/core";
import { createAlertsStreamHandler } from "../alerts";
import { testSseKeepalive } from "./sse-keepalive-contract";

testSseKeepalive({
	name: "alerts",
	create: createAlertsStreamHandler,
	listeners: () => alertEvents.listenerCount("event"),
	emitFailure: () =>
		alertEvents.emit("event", {
			toJSON() {
				throw new Error("cannot serialize");
			},
		} as never),
});
