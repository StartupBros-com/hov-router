import type { ReactNode } from "react";
import { Button } from "./button";
import { Skeleton } from "./skeleton";

/**
 * "page" fills a page or a whole section; "inline" is one line inside a card
 * or a smaller region, so the surrounding layout keeps its shape.
 */
export type StateSize = "page" | "inline";

export function LoadingState({
	label,
	rows = 3,
	size = "page",
}: {
	label: string;
	rows?: number;
	size?: StateSize;
}) {
	if (size === "inline") {
		return (
			<p
				role="status"
				aria-label={label}
				className="text-sm text-muted-foreground"
			>
				{label}…
			</p>
		);
	}
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
	size = "page",
}: {
	title: string;
	message?: string;
	onRetry?: () => void;
	retryLabel?: string;
	size?: StateSize;
}) {
	if (size === "inline") {
		return (
			<div
				role="alert"
				className="flex flex-wrap items-center gap-x-3 gap-y-2 text-sm text-destructive"
			>
				<p className="min-w-0 break-words">
					{message ? `${title}. ${message}` : `${title}.`}
				</p>
				{onRetry && (
					<Button variant="outline" size="touch-sm" onClick={onRetry}>
						{retryLabel}
					</Button>
				)}
			</div>
		);
	}
	return (
		<div
			role="alert"
			className="rounded-md border border-destructive/20 p-4 space-y-2"
		>
			<h3 className="font-medium">{title}</h3>
			{message && (
				<p className="min-w-0 break-words text-muted-foreground">{message}</p>
			)}
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
	size = "page",
}: {
	title: string;
	description?: string;
	action?: ReactNode;
	size?: StateSize;
}) {
	if (size === "inline") {
		const text = (
			<p className="text-sm text-muted-foreground">
				{description ? `${title} ${description}` : title}
			</p>
		);
		return action ? (
			<div className="flex flex-wrap items-center gap-3">
				{text}
				{action}
			</div>
		) : (
			text
		);
	}
	return (
		<div className="flex flex-col items-center gap-3 rounded-lg border border-dashed px-8 py-12 text-center">
			<h3 className="font-medium">{title}</h3>
			{description && (
				<p className="text-sm text-muted-foreground">{description}</p>
			)}
			{action}
		</div>
	);
}
