/** A fall of at least this many utilization points below the running peak is a
 * candidate counter reset. */
export const LIMIT_RESET_DROP_POINTS = 20;

/** A candidate reset counts only when every one of up to this many following
 * readings also stays that far below the peak. */
export const LIMIT_RESET_CONFIRM_READINGS = 3;

export interface LimitCycleMeasurement {
	/** Utilization points consumed across every limit cycle in the window. */
	pointsUsed: number;
	/** Times the provider zeroed the counter without moving resets_at. */
	counterResets: number;
}

/**
 * Measures how many limit points a window's ordered utilization readings
 * consumed and how often the counter was reset inside it. A fall is ignored
 * unless the readings right after it confirm it, so two sources interleaving
 * readings (20/40/20/40) do not invent cycles. After a confirmed reset the
 * first reading is the new baseline. Returns null when there are no readings.
 */
export function measureLimitCycles(
	readings: readonly number[],
): LimitCycleMeasurement | null {
	if (readings.length === 0) return null;
	let floor = 0;
	let peak = readings[0];
	let closedPoints = 0;
	let counterResets = 0;
	for (let i = 1; i < readings.length; i++) {
		const r = readings[i];
		if (peak - r >= LIMIT_RESET_DROP_POINTS) {
			const after = readings.slice(i + 1, i + 1 + LIMIT_RESET_CONFIRM_READINGS);
			if (
				after.length > 0 &&
				after.every((x) => peak - x >= LIMIT_RESET_DROP_POINTS)
			) {
				closedPoints += Math.max(0, peak - floor);
				counterResets += 1;
				floor = r;
				peak = r;
			}
			continue;
		}
		if (r > peak) peak = r;
	}
	return {
		pointsUsed: closedPoints + Math.max(0, peak - floor),
		counterResets,
	};
}
