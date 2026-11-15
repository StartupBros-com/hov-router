import { requestStatusDisplay } from "../../lib/request-status";
import { cn } from "../../lib/utils";
import { StatusPill } from "../ui/status-pill";

/** A request's HTTP status, or "Pending" / "No response" when it has none. */
export function RequestStatusPill({
	statusCode,
	pending,
	isError,
	className,
}: {
	statusCode: number | null | undefined;
	pending: boolean;
	isError: boolean;
	className?: string;
}) {
	const { text, tone } = requestStatusDisplay({ statusCode, pending, isError });
	return (
		<StatusPill tone={tone} className={cn("tabular-nums", className)}>
			{text}
		</StatusPill>
	);
}
