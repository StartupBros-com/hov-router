import type { ComboFamilyAssignment } from "@better-ccflare/types";
import { Plus } from "lucide-react";
import { useState } from "react";
import {
	useCombos,
	useDeleteCombo,
	useEffectiveRouting,
	useFamilies,
	useUpdateCombo,
} from "../../hooks/queries";
import { useApiError } from "../../hooks/useApiError";
import { RoutePageHeader } from "../page-shell";
import { Button } from "../ui/button";
import { Separator } from "../ui/separator";
import { EmptyState, ErrorState, LoadingState } from "../ui/state";
import { ComboCard, type ComboFamilyRoutingCardState } from "./ComboCard";
import { ComboDialog } from "./ComboDialog";
import { CombosIntroCard } from "./CombosIntroCard";
import { FamilyActivationSection } from "./FamilyActivationSection";
import {
	type FamilyRoutingProjection,
	projectFamilyRoutings,
} from "./family-routing";

/**
 * Join assignment configuration to the coherent effective-routing snapshots.
 * A snapshot owns effective counts; an assignment without one remains visible
 * but deliberately has no client-inferred membership count.
 */
export function buildComboFamilyRoutingStates(
	comboId: string,
	assignments: readonly ComboFamilyAssignment[],
	projections: readonly FamilyRoutingProjection[],
): ComboFamilyRoutingCardState[] {
	const projectionByFamily = new Map(
		projections.map((projection) => [projection.family, projection]),
	);
	const statesByFamily = new Map<
		ComboFamilyAssignment["family"],
		ComboFamilyRoutingCardState
	>();

	for (const assignment of assignments) {
		if (assignment.combo_id !== comboId) continue;
		const projection = projectionByFamily.get(assignment.family) ?? null;
		if (projection && projection.assignment.combo_id !== comboId) continue;
		statesByFamily.set(assignment.family, {
			assignment: projection?.assignment ?? assignment,
			routing: projection,
		});
	}

	// A coherent routing snapshot may be newer than the separately cached family
	// list. Preserve every family the server currently assigns to this combo.
	for (const projection of projections) {
		if (projection.assignment.combo_id !== comboId) continue;
		statesByFamily.set(projection.family, {
			assignment: projection.assignment,
			routing: projection,
		});
	}

	return [...statesByFamily.values()];
}

export function CombosTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [editDialogComboId, setEditDialogComboId] = useState<string | null>(
		null,
	);
	const combosQuery = useCombos();
	const { formatError } = useApiError();
	const familiesQuery = useFamilies();
	const effectiveRoutingQuery = useEffectiveRouting();
	const deleteCombo = useDeleteCombo();
	const updateCombo = useUpdateCombo();
	const combos = combosQuery.data?.combos ?? [];
	const families = familiesQuery.data?.families ?? [];
	const effectiveData = effectiveRoutingQuery.data;
	const effectiveViews = effectiveData
		? Array.isArray(effectiveData)
			? effectiveData
			: [effectiveData]
		: [];
	const routingProjections = projectFamilyRoutings(effectiveViews);

	return (
		<div className="space-y-4">
			<RoutePageHeader
				page="combos"
				actions={
					<Button size="touch" onClick={() => setIsCreateDialogOpen(true)}>
						<Plus />
						Create Combo
					</Button>
				}
			/>
			<div className="space-y-6">
				<CombosIntroCard />

				<FamilyActivationSection />

				<Separator />

				<div className="space-y-4">
					<h2 className="text-lg font-semibold">Saved combos</h2>
					{combosQuery.data === undefined ? (
						combosQuery.isError ? (
							<ErrorState
								title="Combos could not load"
								message={formatError(combosQuery.error)}
								onRetry={() => void combosQuery.refetch()}
							/>
						) : (
							<LoadingState label="Loading combos" />
						)
					) : combos.length === 0 ? (
						<EmptyState
							title="No combos yet"
							description="Create one to define a fallback chain."
							action={
								<Button
									size="touch"
									onClick={() => setIsCreateDialogOpen(true)}
								>
									<Plus />
									Create Combo
								</Button>
							}
						/>
					) : null}

					{combos.length > 0 && (
						<div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3">
							{combos.map((combo) => (
								<ComboCard
									key={combo.id}
									combo={combo}
									slotCount={combo.slot_count}
									familyRoutings={buildComboFamilyRoutingStates(
										combo.id,
										families,
										routingProjections,
									)}
									onEdit={() => setEditDialogComboId(combo.id)}
									onDelete={() => deleteCombo.mutate(combo.id)}
									onToggleEnabled={(enabled) =>
										updateCombo.mutate({ id: combo.id, enabled })
									}
								/>
							))}
						</div>
					)}
				</div>

				<ComboDialog
					isOpen={isCreateDialogOpen}
					onClose={() => setIsCreateDialogOpen(false)}
				/>

				<ComboDialog
					isOpen={!!editDialogComboId}
					comboId={editDialogComboId}
					onClose={() => setEditDialogComboId(null)}
				/>
			</div>
		</div>
	);
}
