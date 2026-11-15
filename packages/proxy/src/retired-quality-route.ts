/**
 * The Auto quality lane (`claude-bccf-quality-auto`, `-astra`, `-opus`,
 * `-fable`) was removed in #816. A client still configured with one of its ids
 * gets this 400 before account selection, so the id never reaches a provider
 * as an unknown model name.
 */
export const RETIRED_QUALITY_MODEL_PREFIX = "claude-bccf-quality-";

export const RETIRED_QUALITY_ROUTE_MESSAGE =
	"The Auto quality lane was removed from HoV Router, so model ids starting with " +
	"claude-bccf-quality- are no longer served. Request a stock model such as opus, " +
	"or a route profile listed by GET /v1/models.";

function isRetiredQualityModel(model: unknown): boolean {
	return (
		typeof model === "string" &&
		model.trim().startsWith(RETIRED_QUALITY_MODEL_PREFIX)
	);
}

/** Returns the 400 when either the client's model or the rewritten model is a retired id. */
export function retiredQualityRouteResponse(
	originalModel: unknown,
	effectiveModel: unknown,
): Response | null {
	if (
		!isRetiredQualityModel(originalModel) &&
		!isRetiredQualityModel(effectiveModel)
	)
		return null;
	return Response.json(
		{
			type: "error",
			error: {
				type: "invalid_request_error",
				code: "quality_route_retired",
				message: RETIRED_QUALITY_ROUTE_MESSAGE,
			},
		},
		{ status: 400, headers: { "cache-control": "no-store" } },
	);
}
