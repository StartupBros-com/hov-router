import { PUBLIC_VALUE_PLANS } from "@hov-router/core";
import { useState } from "react";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { Label } from "../ui/label";

interface PublicValueDialogProps {
	isOpen: boolean;
	accountName: string;
	/** Stored label, or "" when none. */
	initialLabel: string;
	/** The account's provider; only that provider's plans are offered. */
	provider: string;
	/** Stored plan key, or null when none. */
	initialPlan: string | null;
	onClose: () => void;
	onSave: (label: string, plan: string | null) => void;
	isLoading?: boolean;
	/** Server error (e.g. the 400 message) shown under the input. */
	error?: string | null;
}

/**
 * Form body, split out so tests can render it without the Radix portal.
 * The server owns label validation; the client only rejects an empty label.
 */
export function PublicValueForm({
	accountName,
	initialLabel,
	provider,
	initialPlan,
	onClose,
	onSave,
	isLoading = false,
	error = null,
}: Omit<PublicValueDialogProps, "isOpen">) {
	const [label, setLabel] = useState(initialLabel);
	const plans = PUBLIC_VALUE_PLANS.filter((plan) => plan.provider === provider);
	// A stored key the catalog no longer offers for this provider shows as "Not set".
	const [plan, setPlan] = useState(
		plans.some((entry) => entry.key === initialPlan) ? (initialPlan ?? "") : "",
	);
	const [localError, setLocalError] = useState("");

	const handleSubmit = (e: React.FormEvent) => {
		e.preventDefault();
		const trimmed = label.trim();
		if (!trimmed) {
			setLocalError("Public label cannot be empty");
			return;
		}
		setLocalError("");
		onSave(trimmed, plan === "" ? null : plan);
	};

	const shownError = localError || error;

	return (
		<form onSubmit={handleSubmit}>
			<DialogHeader>
				<DialogTitle>Public value label</DialogTitle>
				<DialogDescription>
					Choose the label for account "{accountName}" on the public value feed.
				</DialogDescription>
			</DialogHeader>
			<div className="grid gap-4 py-4">
				<div className="grid gap-2">
					<Label htmlFor="public-value-label">Public label</Label>
					<Input
						id="public-value-label"
						value={label}
						onChange={(e) => {
							setLabel(e.target.value);
							setLocalError("");
						}}
						placeholder="e.g. Claude Max #1"
						autoFocus
						disabled={isLoading}
					/>
					<p className="text-xs text-muted-foreground">
						This label is shown publicly on the House of Vibe site. It must not
						be the account name.
					</p>
					<Label htmlFor="public-value-plan">Plan</Label>
					<select
						id="public-value-plan"
						data-test="public-value-plan"
						className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
						value={plan}
						onChange={(e) => setPlan(e.target.value)}
						disabled={isLoading}
					>
						<option value="">Not set</option>
						{plans.map((entry) => (
							<option key={entry.key} value={entry.key}>
								{entry.name} (${entry.monthlyUsd}/month)
							</option>
						))}
					</select>
					<p className="text-xs text-muted-foreground">
						The plan's monthly price is shown publicly next to this account.
					</p>
					{shownError && (
						<p className="text-sm text-destructive" role="alert">
							{shownError}
						</p>
					)}
				</div>
			</div>
			<DialogFooter>
				<Button
					size="touch"
					type="button"
					variant="outline"
					onClick={onClose}
					disabled={isLoading}
				>
					Cancel
				</Button>
				<Button size="touch" type="submit" disabled={isLoading}>
					{isLoading ? "Saving..." : "Save and publish"}
				</Button>
			</DialogFooter>
		</form>
	);
}

export function PublicValueDialog({
	isOpen,
	onClose,
	...formProps
}: PublicValueDialogProps) {
	// Accounts mounts this controller-owned dialog without a DialogTrigger.
	// Capture the opener before the label input autofocuses.
	const [returnFocusTo] = useState(() =>
		typeof document !== "undefined" &&
		document.activeElement instanceof HTMLElement
			? document.activeElement
			: null,
	);
	return (
		<Dialog open={isOpen} onOpenChange={(open) => !open && onClose()}>
			<DialogContent
				onCloseAutoFocus={(event) => {
					if (!returnFocusTo?.isConnected) return;
					event.preventDefault();
					returnFocusTo.focus();
				}}
			>
				<PublicValueForm {...formProps} onClose={onClose} />
			</DialogContent>
		</Dialog>
	);
}
