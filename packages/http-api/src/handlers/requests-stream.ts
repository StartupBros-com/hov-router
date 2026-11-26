import { type RequestEvt, requestEvents } from "@hov-router/core";
import { createEventStreamHandler } from "./event-stream";

export function createRequestsStreamHandler() {
	return createEventStreamHandler<RequestEvt>(requestEvents, "event");
}
