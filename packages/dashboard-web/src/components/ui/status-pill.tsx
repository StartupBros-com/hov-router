import { cva } from "class-variance-authority";
import type { HTMLAttributes } from "react";
import { cn } from "../../lib/utils";

const pillVariants = cva(
	"inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 text-xs font-medium",
	{
		variants: {
			tone: {
				neutral: "bg-muted text-foreground",
				success: "bg-(--success-soft) text-(--success)",
				warning: "bg-(--warning-soft) text-(--warning)",
				danger: "bg-(--danger-soft) text-(--danger)",
				info: "bg-(--info-soft) text-(--info)",
				secondary: "bg-secondary text-secondary-foreground",
				primary: "bg-primary/10 text-foreground",
			},
		},
		defaultVariants: { tone: "neutral" },
	},
);
export type PillTone =
	| "neutral"
	| "success"
	| "warning"
	| "danger"
	| "info"
	| "secondary"
	| "primary";
export function StatusPill({
	tone = "neutral",
	className,
	...props
}: HTMLAttributes<HTMLSpanElement> & { tone?: PillTone }) {
	return (
		<span
			data-tone={tone}
			className={cn(pillVariants({ tone }), className)}
			{...props}
		/>
	);
}
