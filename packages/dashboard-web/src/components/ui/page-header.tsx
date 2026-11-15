import type { ReactNode } from "react";

/**
 * The heading every page opens with: one plain h1, an optional one-line
 * description, and an optional actions slot on the right.
 */
export function PageHeader({
	title,
	description,
	actions,
}: {
	title: string;
	description?: string;
	actions?: ReactNode;
}) {
	return (
		<div className="flex flex-wrap items-center justify-between gap-4">
			<div>
				<h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
				{description && (
					<p className="text-sm text-muted-foreground">{description}</p>
				)}
			</div>
			{actions && (
				<div className="flex min-w-0 flex-wrap items-center gap-3">
					{actions}
				</div>
			)}
		</div>
	);
}
