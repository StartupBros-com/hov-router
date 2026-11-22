import { Braces, Edit, Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import {
	useAccounts,
	useRouteLanes,
	useSaveRouteLanes,
} from "../../hooks/queries";
import { useApiError } from "../../hooks/useApiError";
import {
	isStaleRouteLanesError,
	type RouteLaneDefinition,
	type RouteLanes,
	type RouteLaneView,
	removeLane,
} from "../../lib/route-lanes-api";
import { RoutePageHeader } from "../page-shell";
import { Button } from "../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { Notice } from "../ui/notice";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { StatusPill } from "../ui/status-pill";
import { RouteLaneDialog } from "./RouteLaneDialog";
import { RouteLanesJsonDialog } from "./RouteLanesJsonDialog";

/** Where the lanes in force came from, in words. */
export function routeLanesSourceText(status: RouteLanes["status"]): string {
	const revision =
		status.revision !== undefined ? `, revision ${status.revision}` : "";
	switch (status.source) {
		case "database":
			return `Stored in the router's database${revision}. Edits apply on the next request.`;
		case "file":
			return "Loaded from the profiles file. The first save stores them in the database.";
		case "env":
			return "Loaded from the environment variable. The first save stores them in the database.";
		default:
			return "No lanes yet. The first save stores them in the database.";
	}
}

/** The message for a failed save: a stale revision gets its own. */
export function saveErrorText(
	error: unknown,
	formatError: (error: unknown) => string,
): string {
	return isStaleRouteLanesError(error)
		? "The lanes changed since this page loaded. They have been reloaded; make your edit again."
		: formatError(error);
}

function LaneCard({
	lane,
	onEdit,
	onDelete,
}: {
	lane: RouteLaneView;
	onEdit: () => void;
	onDelete: () => void;
}) {
	const [pickerId] = lane.modelIds;
	return (
		<Card>
			<CardHeader className="pb-3">
				<div className="flex flex-wrap items-start justify-between gap-2">
					<div className="min-w-[10rem] flex-1">
						<CardTitle className="text-base leading-snug">
							{lane.displayName}
						</CardTitle>
						<p className="mt-1 break-all font-mono text-xs text-muted-foreground">
							{pickerId}
						</p>
					</div>
					<div className="flex items-center gap-1">
						<Button
							variant="ghost"
							size="touch-icon"
							onClick={onEdit}
							aria-label={`Edit ${lane.displayName}`}
						>
							<Edit />
						</Button>
						<Button
							variant="ghost"
							size="touch-icon"
							onClick={onDelete}
							aria-label={`Delete ${lane.displayName}`}
						>
							<Trash2 />
						</Button>
					</div>
				</div>
			</CardHeader>
			<CardContent className="space-y-2 pt-0 text-sm">
				<dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
					<dt className="text-muted-foreground">Account</dt>
					<dd className="min-w-0 break-words">
						{lane.selection === "capability"
							? "Any capable account"
							: (lane.accountName ?? lane.accountId ?? "None")}
					</dd>
					<dt className="text-muted-foreground">Model</dt>
					<dd className="min-w-0 break-all font-mono text-xs leading-5">
						{lane.logicalModel}
					</dd>
				</dl>
				<div className="flex flex-wrap gap-1.5">
					{lane.exclusiveAccount && (
						<StatusPill tone="info">Exclusive account</StatusPill>
					)}
					{lane.modelIds.length > 1 && (
						<StatusPill tone="neutral">
							{`${lane.modelIds.length - 1} more picker ${lane.modelIds.length === 2 ? "id" : "ids"}`}
						</StatusPill>
					)}
				</div>
			</CardContent>
		</Card>
	);
}

export function RouteLanesTab() {
	const lanesQuery = useRouteLanes();
	const accountsQuery = useAccounts();
	const save = useSaveRouteLanes();
	const { formatError } = useApiError();
	const [editing, setEditing] = useState<{ id: string | null } | null>(null);
	const [deleting, setDeleting] = useState<RouteLaneView | null>(null);
	const [jsonOpen, setJsonOpen] = useState(false);

	const data = lanesQuery.data;
	const accounts = (accountsQuery.data ?? []).map((account) => ({
		id: account.id,
		name: account.name,
		provider: account.provider,
	}));
	const definitionFor = (id: string | null): RouteLaneDefinition | undefined =>
		id === null
			? undefined
			: data?.profiles.find((profile) => profile.id === id);

	const confirmDelete = () => {
		if (!data || !deleting) return;
		save.mutate(
			{
				revision: data.revision,
				profiles: removeLane(data.profiles, deleting.id),
			},
			{ onSuccess: () => setDeleting(null) },
		);
	};

	const openAdd = () => {
		save.reset();
		setEditing({ id: null });
	};

	return (
		<div className="space-y-4">
			<RoutePageHeader
				page="routeLanes"
				actions={
					data ? (
						<div className="flex flex-wrap gap-2">
							<Button
								size="touch"
								variant="outline"
								onClick={() => {
									save.reset();
									setJsonOpen(true);
								}}
							>
								<Braces />
								Edit as JSON
							</Button>
							<Button size="touch" onClick={openAdd}>
								<Plus />
								Add lane
							</Button>
						</div>
					) : undefined
				}
			/>

			{data === undefined ? (
				lanesQuery.isError ? (
					<ErrorState
						title="Route lanes could not load"
						message={formatError(lanesQuery.error)}
						onRetry={() => void lanesQuery.refetch()}
					/>
				) : (
					<LoadingState label="Loading route lanes" />
				)
			) : (
				<div className="space-y-4">
					<p className="text-sm text-muted-foreground">
						{routeLanesSourceText(data.status)}
					</p>
					{lanesQuery.isError && (
						<Notice tone="warning" title="Showing the last lanes loaded">
							{formatError(lanesQuery.error)}
						</Notice>
					)}
					{data.status.ignored && (
						<Notice tone="info">
							{`The ${data.status.ignored === "file" ? "profiles file" : "environment variable"} is still set but no longer read; these stored lanes are in force.`}
						</Notice>
					)}
					{data.warnings.length > 0 && (
						<Notice tone="warning" title="Lanes that cannot serve">
							<ul className="mt-1 list-disc space-y-0.5 pl-5">
								{data.warnings.map((warning) => (
									<li key={warning}>{warning}</li>
								))}
							</ul>
						</Notice>
					)}
					{data.lanes.length === 0 ? (
						<EmptyState
							title="No route lanes"
							description="Add a lane to put an account-pinned model in Claude Code's /model picker."
							action={
								<Button size="touch" onClick={openAdd}>
									<Plus />
									Add lane
								</Button>
							}
						/>
					) : (
						<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
							{data.lanes.map((lane) => (
								<LaneCard
									key={lane.id}
									lane={lane}
									onEdit={() => {
										save.reset();
										setEditing({ id: lane.id });
									}}
									onDelete={() => {
										save.reset();
										setDeleting(lane);
									}}
								/>
							))}
						</div>
					)}
				</div>
			)}

			{data && editing && (
				<RouteLaneDialog
					key={editing.id ?? "new"}
					open
					data={data}
					definition={definitionFor(editing.id)}
					accounts={accounts}
					save={save}
					errorText={
						save.isError ? saveErrorText(save.error, formatError) : null
					}
					onClose={() => setEditing(null)}
				/>
			)}

			{data && jsonOpen && (
				<RouteLanesJsonDialog
					open
					data={data}
					save={save}
					errorText={
						save.isError ? saveErrorText(save.error, formatError) : null
					}
					onClose={() => setJsonOpen(false)}
				/>
			)}

			<Dialog
				open={deleting !== null}
				onOpenChange={(open) => {
					if (!open) setDeleting(null);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>Delete lane</DialogTitle>
						<DialogDescription>
							{deleting
								? `Remove ${deleting.displayName} from the /model picker. Sessions on it stop routing through it on their next request.`
								: ""}
						</DialogDescription>
					</DialogHeader>
					{save.isError && (
						<Notice tone="danger">
							{saveErrorText(save.error, formatError)}
						</Notice>
					)}
					<DialogFooter>
						<Button
							size="touch"
							variant="outline"
							onClick={() => setDeleting(null)}
						>
							Cancel
						</Button>
						<Button
							size="touch"
							variant="destructive"
							onClick={confirmDelete}
							disabled={save.isPending}
						>
							{save.isPending ? "Deleting..." : "Delete lane"}
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</div>
	);
}
