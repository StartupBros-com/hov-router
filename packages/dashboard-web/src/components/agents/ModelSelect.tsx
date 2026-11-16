import {
	AGENT_DEFAULT_MODEL_SENTINEL,
	useModelOptions,
} from "../../hooks/queries";
import { cn } from "../../lib/utils";
import { Badge } from "../ui/badge";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";

interface ModelSelectDefaultItem {
	label: string;
	/** Omit to render the default item without a badge. */
	badgeLabel?: string;
}

interface ModelSelectProps {
	value?: string;
	onValueChange: (value: string) => void;
	disabled?: boolean;
	placeholder?: string;
	triggerClassName?: string;
	ariaLabel?: string;
	/**
	 * When provided, renders a first SelectItem for
	 * `AGENT_DEFAULT_MODEL_SENTINEL` — the "leave unset / fall back to
	 * default" option. Omit this when the caller requires a concrete model
	 * value (e.g. saving agent frontmatter).
	 */
	defaultItem?: ModelSelectDefaultItem;
}

/**
 * One option's text, in the list and in the closed trigger. The label stays
 * on one line, truncated with its full text in a title, and the badge keeps
 * its size. The default option's muted label takes the highlighted row's
 * colour, and its outline badge gets an opaque fill so the highlight cannot
 * show through it.
 */
export function ModelOptionLabel({
	label,
	badge,
	isDefault = false,
}: {
	label: string;
	badge?: string;
	isDefault?: boolean;
}) {
	return (
		<span className="flex min-w-0 items-center gap-2">
			<span
				className={cn(
					"truncate",
					isDefault && "text-muted-foreground in-data-highlighted:text-current",
				)}
				title={label}
			>
				{label}
			</span>
			{badge && (
				<Badge
					variant={isDefault ? "outline" : "secondary"}
					className={cn("shrink-0 text-xs", isDefault && "bg-popover")}
				>
					{badge}
				</Badge>
			)}
		</span>
	);
}

/** Lets each option's text span shrink, so a long label truncates instead of widening the list. */
const ITEM_CLASS = "flex items-center *:min-w-0";

/**
 * Shared model dropdown: catalog options sourced from `useModelOptions`
 * (live Anthropic model list, falling back to the bundled static list),
 * each tagged with a "Premium" badge when its id contains "opus". This is
 * the single source of truth for model selects across the Agents UI.
 */
export function ModelSelect({
	value,
	onValueChange,
	disabled,
	placeholder,
	triggerClassName,
	ariaLabel,
	defaultItem,
}: ModelSelectProps) {
	const modelOptions = useModelOptions();

	return (
		<Select value={value} onValueChange={onValueChange} disabled={disabled}>
			<SelectTrigger
				className={triggerClassName}
				aria-label={ariaLabel ?? "Model"}
			>
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			{/* Never wider than the room beside the trigger: at 320 px the list was 414 px wide. */}
			<SelectContent className="max-w-(--radix-select-content-available-width)">
				{defaultItem && (
					<SelectItem
						value={AGENT_DEFAULT_MODEL_SENTINEL}
						className={ITEM_CLASS}
					>
						<ModelOptionLabel
							label={defaultItem.label}
							badge={defaultItem.badgeLabel}
							isDefault
						/>
					</SelectItem>
				)}
				{modelOptions.map((model) => (
					<SelectItem key={model.id} value={model.id} className={ITEM_CLASS}>
						<ModelOptionLabel
							label={model.displayName}
							badge={model.id.includes("opus") ? "Premium" : undefined}
						/>
					</SelectItem>
				))}
			</SelectContent>
		</Select>
	);
}
