import { useState } from "react";
import type { useSaveRouteLanes } from "../../hooks/queries";
import {
	EMPTY_LANE_FORM,
	findLane,
	laneEditSave,
	laneFormValues,
	type RouteLaneFormValues,
	type RouteLanes,
} from "../../lib/route-lanes-api";
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
import { Notice } from "../ui/notice";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "../ui/select";
import { SwitchRow } from "../ui/switch-row";

export interface RouteLaneAccountOption {
	id: string;
	name: string;
	provider: string;
}

/** The fields the form needs before it can save; the server checks the rest. */
export function laneFormMissing(values: RouteLaneFormValues): string[] {
	const missing: string[] = [];
	if (!values.id.trim()) missing.push("id");
	if (!values.displayName.trim()) missing.push("display name");
	if (!values.accountId.trim()) missing.push("account");
	if (!values.logicalModel.trim()) missing.push("model");
	return missing;
}

interface RouteLaneFormProps {
	/** The lanes as they were when the dialog opened; the save is built on these. */
	base: RouteLanes;
	/** The lane being edited, or null to add one. */
	originalId: string | null;
	accounts: readonly RouteLaneAccountOption[];
	save: ReturnType<typeof useSaveRouteLanes>;
	errorText: string | null;
	/** A save was refused as stale: saving again needs a fresh open. */
	stale: boolean;
	onClose: () => void;
}

/**
 * Add or edit one account-pinned lane. Fields the form does not show
 * (aliases, effort, context window and the rest) are kept as written; a
 * capability lane, which has no account, is edited as JSON instead.
 */
export function RouteLaneDialog({
	open,
	...props
}: RouteLaneFormProps & { open: boolean }) {
	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) props.onClose();
			}}
		>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-lg">
				<DialogHeader>
					<DialogTitle>
						{props.originalId === null ? "Add lane" : "Edit lane"}
					</DialogTitle>
					<DialogDescription>
						A lane appears in Claude Code&apos;s /model picker as
						claude-bccf-route-&lt;id&gt; and sends that session, and its
						subagents, to one account.
					</DialogDescription>
				</DialogHeader>
				<RouteLaneForm {...props} />
			</DialogContent>
		</Dialog>
	);
}

/** The dialog's body, rendered on its own in tests. */
export function RouteLaneForm({
	base,
	originalId,
	accounts,
	save,
	errorText,
	stale,
	onClose,
}: RouteLaneFormProps) {
	const definition =
		originalId === null ? undefined : findLane(base.profiles, originalId);
	const [values, setValues] = useState<RouteLaneFormValues>(() =>
		definition ? laneFormValues(definition) : EMPTY_LANE_FORM,
	);
	const set = <K extends keyof RouteLaneFormValues>(
		key: K,
		value: RouteLaneFormValues[K],
	) => setValues((current) => ({ ...current, [key]: value }));

	const isCapability = definition?.selection === "capability";
	const missing = laneFormMissing(values);
	const knownAccount = accounts.some(
		(account) => account.id === values.accountId,
	);

	const submit = () => {
		if (missing.length > 0 || isCapability || stale) return;
		save.mutate(laneEditSave(base, originalId, values), {
			onSuccess: onClose,
		});
	};

	return isCapability ? (
		<Notice tone="info">
			This lane picks any capable account rather than one account. Edit it with
			Edit as JSON.
		</Notice>
	) : (
		<form
			className="space-y-4"
			onSubmit={(event) => {
				event.preventDefault();
				submit();
			}}
		>
			<div className="space-y-1.5">
				<Label htmlFor="lane-id">Id</Label>
				<Input
					id="lane-id"
					value={values.id}
					onChange={(event) => set("id", event.target.value)}
					placeholder="cvp-opus"
					autoComplete="off"
					spellCheck={false}
					className="min-h-11 font-mono"
				/>
				<p className="text-xs text-muted-foreground">
					Lowercase letters, digits and dashes. Renaming a lane drops the
					sessions on its old id unless you keep the old id in aliases (Edit as
					JSON).
				</p>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="lane-name">Display name</Label>
				<Input
					id="lane-name"
					value={values.displayName}
					onChange={(event) => set("displayName", event.target.value)}
					placeholder="CVP Opus"
					className="min-h-11"
				/>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="lane-account">Account</Label>
				<Select
					value={values.accountId || undefined}
					onValueChange={(value) => set("accountId", value)}
				>
					<SelectTrigger id="lane-account" className="min-h-11">
						<SelectValue placeholder="Choose an account" />
					</SelectTrigger>
					<SelectContent>
						{!knownAccount && values.accountId && (
							<SelectItem value={values.accountId}>
								{`${values.accountId} (no such account)`}
							</SelectItem>
						)}
						{accounts.map((account) => (
							<SelectItem key={account.id} value={account.id}>
								{`${account.name} · ${account.provider}`}
							</SelectItem>
						))}
					</SelectContent>
				</Select>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="lane-model">Model</Label>
				<Input
					id="lane-model"
					value={values.logicalModel}
					onChange={(event) => set("logicalModel", event.target.value)}
					placeholder="opus"
					autoComplete="off"
					spellCheck={false}
					className="min-h-11 font-mono"
				/>
				<p className="text-xs text-muted-foreground">
					A family name (opus, sonnet, haiku, fable, mythos) follows the newest
					model of that family; a full model id pins one.
				</p>
			</div>
			<div className="space-y-1.5">
				<Label htmlFor="lane-description">Description (optional)</Label>
				<Input
					id="lane-description"
					value={values.description}
					onChange={(event) => set("description", event.target.value)}
					className="min-h-11"
				/>
			</div>
			<SwitchRow
				id="lane-exclusive"
				label="Exclusive account"
				description="Only this lane may use the account; ordinary routing skips it."
				checked={values.exclusiveAccount}
				onCheckedChange={(checked) => set("exclusiveAccount", checked)}
			/>
			{errorText && <Notice tone="danger">{errorText}</Notice>}
			<DialogFooter>
				<Button type="button" size="touch" variant="outline" onClick={onClose}>
					Cancel
				</Button>
				<Button
					type="submit"
					size="touch"
					disabled={missing.length > 0 || save.isPending || stale}
				>
					{save.isPending ? "Saving..." : "Save lane"}
				</Button>
			</DialogFooter>
		</form>
	);
}
