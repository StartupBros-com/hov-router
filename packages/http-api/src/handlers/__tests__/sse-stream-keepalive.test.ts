import { requestEvents } from "@hov-router/core";
import { logBus } from "@hov-router/logger";
import { createLogsStreamHandler } from "../logs";
import { createRequestsStreamHandler } from "../requests-stream";
import { testSseKeepalive } from "./sse-keepalive-contract";

testSseKeepalive({
	name: "requests",
	create: createRequestsStreamHandler,
	listeners: () => requestEvents.listenerCount("event"),
	emitFailure: () =>
		requestEvents.emit("event", {
			toJSON() {
				throw new Error("cannot serialize");
			},
		} as never),
});
testSseKeepalive({
	name: "logs",
	create: createLogsStreamHandler,
	listeners: () => logBus.listenerCount("log"),
	emitFailure: () =>
		logBus.emit("log", {
			toJSON() {
				throw new Error("cannot serialize");
			},
		} as never),
});
