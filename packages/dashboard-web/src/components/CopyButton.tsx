import { AlertCircle, Check, Copy, Loader2 } from "lucide-react";
import { type ComponentProps, useRef, useState } from "react";
import { copyText } from "../lib/clipboard";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";

interface CopyButtonProps {
	/**
	 * String or function returning the string to copy.
	 */
	value?: string;
	getValue?: () => string;
	/**
	 * Async value resolver. Used when the value isn't available synchronously
	 * (e.g. when bodies need to be lazy-fetched). When set, the button shows a
	 * spinner while resolving.
	 */
	getValueAsync?: () => Promise<string>;
	/**
	 * Forwarded props to underlying Button
	 */
	variant?: ComponentProps<typeof Button>["variant"];
	size?: ComponentProps<typeof Button>["size"];
	className?: string;
	/**
	 * Children to render inside the button. If provided, an icon will be shown to the left.
	 */
	children?: React.ReactNode;
	/**
	 * Optional title attribute for accessibility.
	 */
	title?: string;
	/**
	 * Accessible name. When set, a screen reader also hears "Copied" or
	 * "Copy failed" after a click.
	 */
	label?: string;
}

type CopyState = "idle" | "loading" | "copied" | "errored";

/** What the button shows in each copy state. */
export function CopyButtonFace({
	state,
	children,
}: {
	state: CopyState;
	children?: React.ReactNode;
}) {
	if (state === "loading") return <Loader2 className="h-4 w-4 animate-spin" />;
	if (state === "errored") {
		return children ? (
			<>
				<AlertCircle className="h-4 w-4 mr-1 text-destructive" />
				Copy failed
			</>
		) : (
			<span className="animate-pulse text-destructive" title="Copy failed">
				<AlertCircle className="h-4 w-4" />
			</span>
		);
	}
	if (state === "copied") {
		return children ? (
			<>
				<Check className="h-4 w-4 mr-1" />
				Copied
			</>
		) : (
			<span className="animate-pulse">
				<Check className="h-4 w-4" />
			</span>
		);
	}
	return children ? (
		<>
			<Copy className="h-4 w-4 mr-1" />
			{children}
		</>
	) : (
		<Copy className="h-4 w-4" />
	);
}

/**
 * A small wrapper around the standard Button that copies supplied text to the
 * clipboard and temporarily shows a "Copied!" label with a subtle animation.
 */
export function CopyButton({
	value,
	getValue,
	getValueAsync,
	variant = "ghost",
	size = "sm",
	className,
	children,
	title,
	label,
}: CopyButtonProps) {
	const [copied, setCopied] = useState(false);
	const [loading, setLoading] = useState(false);
	const [errored, setErrored] = useState(false);
	const timeoutRef = useRef<number | null>(null);

	const flashError = (err: unknown) => {
		console.error("Copy failed", err);
		setErrored(true);
		// Clear any lingering success state — `clearTimeout` below cancels
		// the success-reset job too, so without `setCopied(false)` a failure
		// that follows a recent success within 1.5 s would leave the Check
		// icon shown indefinitely (until unmount).
		setCopied(false);
		if (timeoutRef.current) {
			window.clearTimeout(timeoutRef.current);
		}
		timeoutRef.current = window.setTimeout(() => setErrored(false), 1500);
	};

	const finishCopy = (text: string) => {
		if (!text) {
			flashError(new Error("No value to copy"));
			return;
		}

		copyText(text)
			.then(() => {
				setCopied(true);
				// Clear any lingering error state from a previous attempt.
				// `clearTimeout` below cancels the error-reset job too, so
				// without this `setErrored(false)` a retry that succeeds within
				// 1.5 s of a failed attempt would leave the AlertCircle icon
				// shown indefinitely (until unmount).
				setErrored(false);
				if (timeoutRef.current) {
					window.clearTimeout(timeoutRef.current);
				}
				timeoutRef.current = window.setTimeout(() => setCopied(false), 1500);
			})
			.catch((err) => flashError(err));
	};

	const handleCopy = () => {
		if (loading) return;
		if (typeof getValueAsync === "function") {
			setLoading(true);
			getValueAsync()
				.then((text) => finishCopy(text))
				.catch((err) => flashError(err))
				.finally(() => setLoading(false));
			return;
		}
		const text = typeof getValue === "function" ? getValue() : (value ?? "");
		finishCopy(text);
	};

	const state: CopyState = loading
		? "loading"
		: errored
			? "errored"
			: copied
				? "copied"
				: "idle";
	const button = (
		<Button
			variant={variant}
			size={size}
			onClick={handleCopy}
			title={title}
			aria-label={label}
			className={cn("relative overflow-hidden", className)}
			disabled={loading}
		>
			<CopyButtonFace state={state}>{children}</CopyButtonFace>
		</Button>
	);
	if (!label) return button;
	// Outside the button: a button's contents are presentational, so a live
	// region inside it may never be announced.
	return (
		<>
			{button}
			<span role="status" className="sr-only">
				{state === "copied"
					? "Copied"
					: state === "errored"
						? "Copy failed"
						: ""}
			</span>
		</>
	);
}
