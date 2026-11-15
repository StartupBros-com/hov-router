import type {
	ActiveRequestFilter,
	RequestFilterKey,
} from "../../lib/request-filters";
import { Button } from "../ui/button";
import { FilterChip } from "./FilterChip";

/** The filters that are on, how many requests they leave, and Clear all. */
export function ActiveFilterBar({
	filters,
	shown,
	total,
	onRemove,
	onClearAll,
}: {
	filters: ActiveRequestFilter[];
	shown: number;
	total: number;
	onRemove: (key: RequestFilterKey) => void;
	onClearAll: () => void;
}) {
	if (filters.length === 0) return null;
	return (
		<div className="mb-4 flex flex-wrap items-center gap-2 rounded-lg bg-muted/50 p-3">
			{filters.map((filter) => (
				<FilterChip
					key={filter.key}
					label={filter.label}
					value={filter.value}
					onRemove={() => onRemove(filter.key)}
				/>
			))}
			<div className="ml-auto flex items-center gap-2">
				<span className="text-xs text-muted-foreground tabular-nums">
					{shown} of {total} requests
				</span>
				<Button
					type="button"
					variant="ghost"
					size="touch-sm"
					onClick={onClearAll}
				>
					Clear all
				</Button>
			</div>
		</div>
	);
}
