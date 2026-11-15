import {
	formatEventTime,
	formatEventTimeFull,
} from "@better-ccflare/ui-common";

/**
 * When an event happened: "1:42:05 PM", or "Nov 14, 1:42:05 PM" when it was not
 * today, with the full date in the tooltip. A bad timestamp reads "Unknown
 * time" rather than throwing.
 */
export function EventTime({
	value,
	now = Date.now(),
	className,
}: {
	value: number;
	now?: number;
	className?: string;
}) {
	if (!Number.isFinite(value)) {
		return <span className={className}>Unknown time</span>;
	}
	return (
		<time
			dateTime={new Date(value).toISOString()}
			title={formatEventTimeFull(value)}
			className={className}
		>
			{formatEventTime(value, now)}
		</time>
	);
}
