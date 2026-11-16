import { cva } from "class-variance-authority";
import { AlertTriangle, Info } from "lucide-react";
import type { HTMLAttributes, ReactNode } from "react";
import { cn } from "../../lib/utils";

const noticeVariants = cva(
	"flex items-start gap-2 rounded-lg border p-3 text-sm",
	{
		variants: {
			tone: {
				warning: "border-(--warning)/30 bg-(--warning-soft) text-(--warning)",
				danger: "border-destructive/30 bg-destructive/10 text-destructive",
				info: "border-(--info)/30 bg-(--info-soft) text-(--info)",
			},
		},
		defaultVariants: { tone: "warning" },
	},
);

export type NoticeTone = "warning" | "danger" | "info";

/**
 * A boxed message inside a card or dialog. A danger notice is an error the
 * user should hear about, so it is announced as an alert; the others are not.
 */
export function Notice({
	tone = "warning",
	title,
	action,
	className,
	children,
	...props
}: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
	tone?: NoticeTone;
	title?: ReactNode;
	action?: ReactNode;
}) {
	const Icon = tone === "info" ? Info : AlertTriangle;
	return (
		<div
			role={tone === "danger" ? "alert" : undefined}
			data-tone={tone}
			className={cn(noticeVariants({ tone }), className)}
			{...props}
		>
			<Icon className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
			<div className="min-w-0 flex-1 break-words">
				{title && <p className="font-medium">{title}</p>}
				{children}
			</div>
			{action}
		</div>
	);
}
