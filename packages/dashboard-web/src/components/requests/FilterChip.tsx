import { X } from "lucide-react";
import { Button } from "../ui/button";

/** An active filter. Clicking anywhere on it removes the filter. */
export function FilterChip({
	label,
	value,
	onRemove,
}: {
	label: string;
	value: string;
	onRemove: () => void;
}) {
	return (
		<Button
			type="button"
			variant="outline"
			size="touch-sm"
			className="max-w-full rounded-full font-normal"
			onClick={onRemove}
			aria-label={`Remove filter ${label}: ${value}`}
		>
			<span className="truncate">
				<span className="text-muted-foreground">{label}:</span> {value}
			</span>
			<X aria-hidden="true" />
		</Button>
	);
}
