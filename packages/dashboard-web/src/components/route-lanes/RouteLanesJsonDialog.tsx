import { useState } from "react";
import type { useSaveRouteLanes } from "../../hooks/queries";
import {
	formatLaneSet,
	parseLaneSetText,
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
import { Label } from "../ui/label";
import { Notice } from "../ui/notice";

/**
 * The whole lane set as written, for every field the form does not cover
 * (aliases, effort, context window, capability lanes). Saved as one set.
 */
export function RouteLanesJsonDialog({
	open,
	data,
	save,
	errorText,
	onClose,
}: {
	open: boolean;
	data: RouteLanes;
	save: ReturnType<typeof useSaveRouteLanes>;
	errorText: string | null;
	onClose: () => void;
}) {
	const [text, setText] = useState(() => formatLaneSet(data.profiles));
	const [parseError, setParseError] = useState<string | null>(null);

	const submit = () => {
		const parsed = parseLaneSetText(text);
		if (!parsed.ok) {
			setParseError(parsed.error);
			return;
		}
		setParseError(null);
		save.mutate(
			{ revision: data.revision, profiles: parsed.profiles },
			{ onSuccess: onClose },
		);
	};

	return (
		<Dialog
			open={open}
			onOpenChange={(next) => {
				if (!next) onClose();
			}}
		>
			<DialogContent className="max-h-[90vh] overflow-y-auto sm:max-w-3xl">
				<DialogHeader>
					<DialogTitle>Edit lanes as JSON</DialogTitle>
					<DialogDescription>
						{`The whole set, as stored at revision ${data.revision}. Saving replaces every lane.`}
					</DialogDescription>
				</DialogHeader>
				<div className="space-y-1.5">
					<Label htmlFor="lanes-json">Lanes</Label>
					<textarea
						id="lanes-json"
						value={text}
						onChange={(event) => setText(event.target.value)}
						rows={18}
						spellCheck={false}
						className="flex min-h-[320px] w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-xs leading-5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
					/>
				</div>
				{(parseError ?? errorText) && (
					<Notice tone="danger">{parseError ?? errorText}</Notice>
				)}
				<DialogFooter>
					<Button
						type="button"
						size="touch"
						variant="outline"
						onClick={onClose}
					>
						Cancel
					</Button>
					<Button
						type="button"
						size="touch"
						onClick={submit}
						disabled={save.isPending}
					>
						{save.isPending ? "Saving..." : "Save lanes"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
