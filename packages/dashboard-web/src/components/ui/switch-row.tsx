import { type ComponentPropsWithoutRef, type ReactNode, useId } from "react";
import { cn } from "../../lib/utils";
import { Label } from "./label";
import { Switch } from "./switch";

type SwitchProps = ComponentPropsWithoutRef<typeof Switch>;

/**
 * A setting with a visible label of its own. The label is the switch's 44 px
 * click target, as on the Requests details dialog's Beautify switch.
 */
export function SwitchRow({
	id,
	label,
	description,
	labelClassName,
	className,
	...switchProps
}: SwitchProps & {
	id: string;
	label: ReactNode;
	description?: ReactNode;
	labelClassName?: string;
}) {
	const descriptionId = description ? `${id}-description` : undefined;
	return (
		<div className={cn("flex items-center justify-between gap-3", className)}>
			<div className="min-w-0">
				<Label
					htmlFor={id}
					className={cn("inline-flex min-h-11 items-center", labelClassName)}
				>
					{label}
				</Label>
				{description && (
					<div id={descriptionId} className="text-sm text-muted-foreground">
						{description}
					</div>
				)}
			</div>
			<Switch id={id} aria-describedby={descriptionId} {...switchProps} />
		</div>
	);
}

/**
 * A 44 x 44 click target around a switch with no visible label of its own,
 * whose name comes from `aria-label`. Clicking anywhere in the box toggles
 * the switch it wraps, and nothing outside the box does.
 */
export function SwitchHitArea({ id, className, ...switchProps }: SwitchProps) {
	const generatedId = useId();
	const switchId = id ?? generatedId;
	return (
		<label
			htmlFor={switchId}
			className={cn(
				"inline-flex h-11 w-11 shrink-0 cursor-pointer items-center justify-center",
				className,
			)}
		>
			<Switch id={switchId} {...switchProps} />
		</label>
	);
}
