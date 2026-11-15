import { cn } from "../../lib/utils";
import { Progress } from "./progress";

/**
 * How much a usage bar should draw the eye. "strong" is the bar that matters
 * now, "weak" one that does not bind yet, "exhausted" one with nothing left.
 */
export type MeterTone = "strong" | "weak" | "exhausted";

export const METER_TONE_CLASS: Record<MeterTone, string> = {
	strong: "bg-foreground",
	weak: "bg-muted-foreground",
	exhausted: "bg-destructive",
};

export const METER_TRACK_CLASS = "bg-muted-foreground/25";

type MeterLabel =
	| { "aria-label": string; "aria-labelledby"?: never }
	| { "aria-labelledby": string; "aria-label"?: never };

export type MeterProps = MeterLabel & {
	value: number | null;
	tone?: MeterTone;
	max?: number;
	className?: string;
};

/**
 * A neutral usage bar: the Accounts quota bar, shared. The track class comes
 * last so a caller's size classes keep and its background classes cannot
 * override the track.
 */
export function Meter({
	value,
	tone = "strong",
	max,
	className,
	...label
}: MeterProps) {
	return (
		<Progress
			value={value}
			max={max}
			{...label}
			className={cn(className, METER_TRACK_CLASS)}
			indicatorClassName={METER_TONE_CLASS[tone]}
		/>
	);
}
