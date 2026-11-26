import { ValidationError } from "./errors";

/** Reject retired inputs before an account mutation can silently ignore them. */
export function rejectRetiredModelMappingInput(
	body: Record<string, unknown>,
): void {
	let endpoint = body.customEndpoint;
	if (typeof endpoint === "string" && endpoint.trim().startsWith("{")) {
		try {
			endpoint = JSON.parse(endpoint);
		} catch {
			// Endpoint validation reports malformed JSON separately.
		}
	}
	const wrapped = body.model_mappings ?? body.modelMappings;
	let mappings = wrapped;
	if (typeof mappings === "string") {
		try {
			mappings = JSON.parse(mappings);
		} catch {
			// Mapping validation reports malformed JSON separately.
		}
	}
	if (
		Object.hasOwn(body, "modelFallbacks") ||
		(endpoint !== null &&
			typeof endpoint === "object" &&
			Object.hasOwn(endpoint, "modelMappings")) ||
		(mappings !== null &&
			typeof mappings === "object" &&
			Object.hasOwn(mappings, "modelMappings"))
	) {
		throw new ValidationError(
			"Old model mapping formats were removed in 7.0.0; put ordered candidates in modelMappings arrays",
			"modelMappings",
		);
	}
}
