import type { ReactNode } from "react";
import { Button } from "./button";
import { Skeleton } from "./skeleton";

export function LoadingState({
	label,
	rows = 3,
}: {
	label: string;
	rows?: number;
}) {
	return (
		<div role="status" aria-label={label} className="space-y-4">
			<p className="text-muted-foreground">{label}…</p>
			{Array.from({ length: rows }, (_, index) => (
				// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length placeholder rows with no state; they never reorder
				<Skeleton key={index} className="h-20 w-full" />
			))}
		</div>
	);
}
export function ErrorState({
	title,
	message,
	onRetry,
	retryLabel = "Retry",
}: {
	title: string;
	message: string;
	onRetry?: () => void;
	retryLabel?: string;
}) {
	return (
		<div
			role="alert"
			className="rounded-md border border-destructive/20 p-4 space-y-2"
		>
			<h3 className="font-medium">{title}</h3>
			<p className="min-w-0 break-words text-muted-foreground">{message}</p>
			{onRetry && (
				<Button variant="outline" size="touch" onClick={onRetry}>
					{retryLabel}
				</Button>
			)}
		</div>
	);
}
export function EmptyState({
	title,
	description,
	action,
}: {
	title: string;
	description?: string;
	action?: ReactNode;
}) {
	return (
		<div className="space-y-2">
			<h3 className="font-medium">{title}</h3>
			{description && <p className="text-muted-foreground">{description}</p>}
			{action}
		</div>
	);
}
