import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { formatDistanceToNow } from "date-fns";
import {
	ChevronDown,
	Plus,
	Shield,
	ToggleLeft,
	ToggleRight,
	Trash2,
	X,
} from "lucide-react";
import { useEffect, useState } from "react";
import { api } from "../api";
import { useApiError } from "../hooks/useApiError";
import { CopyButton } from "./CopyButton";
import { RoutePageHeader } from "./page-shell";
import { Button } from "./ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "./ui/card";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "./ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Notice } from "./ui/notice";
import { StatTile } from "./ui/stat-tile";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { type PillTone, StatusPill } from "./ui/status-pill";

const ROLE_TONE: Record<"admin" | "api-only", PillTone> = {
	admin: "warning",
	"api-only": "info",
};

interface ApiKey {
	id: string;
	name: string;
	prefixLast8: string;
	createdAt: string;
	lastUsed: string | null;
	usageCount: number;
	isActive: boolean;
	role: "admin" | "api-only";
}

interface ApiKeysResponse {
	success: boolean;
	data: ApiKey[];
	count: number;
}

interface ApiKeyStatsResponse {
	success: boolean;
	data: {
		total: number;
		active: number;
		inactive: number;
	};
}

interface ApiKeyGenerationResponse {
	success: boolean;
	data: {
		id: string;
		name: string;
		apiKey: string; // Full API key shown only once
		prefixLast8: string;
		createdAt: string;
		role: "admin" | "api-only";
	};
}

export function ApiKeysTab() {
	const [isCreateDialogOpen, setIsCreateDialogOpen] = useState(false);
	const [isDeleteDialogOpen, setIsDeleteDialogOpen] = useState(false);
	const [newKeyName, setNewKeyName] = useState("");
	const [selectedKey, setSelectedKey] = useState<ApiKey | null>(null);
	const [generatedKey, setGeneratedKey] = useState<string | null>(null);
	const [isAdminKey, setIsAdminKey] = useState(false);

	const queryClient = useQueryClient();
	const { formatError } = useApiError();

	// Fetch API key statistics - only when not showing the generated key dialog
	const {
		data: statsResponse,
		error: statsError,
		isError: isStatsError,
		refetch: refetchStats,
	} = useQuery<ApiKeyStatsResponse>({
		queryKey: ["api-keys-stats"],
		queryFn: async () => {
			return api.get<ApiKeyStatsResponse>("/api/api-keys/stats");
		},
		enabled: !generatedKey, // Don't fetch while showing generated key
	});

	// Default to admin if this is the first key, otherwise api-only
	useEffect(() => {
		if (statsResponse?.data) {
			setIsAdminKey(statsResponse.data.active === 0);
		}
	}, [statsResponse]);

	// Fetch API keys - only when not showing the generated key dialog
	const {
		data: apiKeysResponse,
		isError: isKeysError,
		refetch: refetchKeys,
		error: keysError,
	} = useQuery<ApiKeysResponse>({
		queryKey: ["api-keys"],
		queryFn: async () => {
			return api.get<ApiKeysResponse>("/api/api-keys");
		},
		enabled: !generatedKey, // Don't fetch while showing generated key
	});

	// Generate API key mutation
	const generateKeyMutation = useMutation({
		mutationFn: async (params: {
			name: string;
			role: "admin" | "api-only";
		}) => {
			const result = await api.post<ApiKeyGenerationResponse>("/api/api-keys", {
				name: params.name,
				role: params.role,
			});
			return result.data;
		},
		onSuccess: (data) => {
			setGeneratedKey(data.apiKey);
			setNewKeyName("");
			setIsAdminKey(false);
			setIsCreateDialogOpen(false);
			// Don't invalidate queries here - wait until user authenticates
			// This prevents 401 errors if the stored key is invalid
		},
		onError: (error: Error) => {
			console.error("Failed to generate API key:", error);
		},
	});

	const handleSavedKey = () => {
		// Close the dialog
		setGeneratedKey(null);
		// Trigger auth dialog so user can paste the key they just copied
		window.dispatchEvent(new CustomEvent("auth-required"));
	};

	// Toggle API key status mutation
	const toggleKeyMutation = useMutation({
		mutationFn: async ({ name, enable }: { name: string; enable: boolean }) => {
			const endpoint = enable
				? `/api/api-keys/${encodeURIComponent(name)}/enable`
				: `/api/api-keys/${encodeURIComponent(name)}/disable`;
			return api.post(endpoint);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to toggle API key:", error);
		},
	});

	// Delete API key mutation
	const deleteKeyMutation = useMutation({
		mutationFn: async (name: string) => {
			return api.delete(`/api/api-keys/${encodeURIComponent(name)}`);
		},
		onSuccess: () => {
			setSelectedKey(null);
			setIsDeleteDialogOpen(false);
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to delete API key:", error);
		},
	});

	// Update API key role mutation
	const updateRoleMutation = useMutation({
		mutationFn: async ({
			keyId,
			role,
		}: {
			keyId: string;
			role: "admin" | "api-only";
		}) => {
			return api.updateApiKeyRole(keyId, role);
		},
		onSuccess: () => {
			queryClient.invalidateQueries({ queryKey: ["api-keys"] });
			queryClient.invalidateQueries({ queryKey: ["api-keys-stats"] });
		},
		onError: (error: Error) => {
			console.error("Failed to update API key role:", error);
		},
	});

	const handleGenerateKey = () => {
		if (!newKeyName.trim()) return;
		const isFirstKey = !stats || stats.active === 0;
		const role = isFirstKey || isAdminKey ? "admin" : "api-only";
		generateKeyMutation.mutate({ name: newKeyName.trim(), role });
	};

	const handleToggleKey = (key: ApiKey, enable: boolean) => {
		toggleKeyMutation.mutate({ name: key.name, enable });
	};

	const handleDeleteKey = (key: ApiKey) => {
		setSelectedKey(key);
		setIsDeleteDialogOpen(true);
	};

	const confirmDeleteKey = () => {
		if (selectedKey) {
			deleteKeyMutation.mutate(selectedKey.name);
		}
	};

	const handleUpdateRole = (key: ApiKey, newRole: "admin" | "api-only") => {
		if (key.role === newRole) return;
		updateRoleMutation.mutate({ keyId: key.id, role: newRole });
	};

	// Determine if a key's role can be changed
	const canChangeRole = (key: ApiKey) => {
		// Cannot change the first key (oldest by creation date)
		const sortedKeys = [...apiKeys].sort(
			(a, b) =>
				new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
		);
		const firstKey = sortedKeys[0];
		if (firstKey && key.id === firstKey.id) {
			return false;
		}

		// Get the current authenticated key from session storage
		const currentApiKey = api.getApiKey();
		if (currentApiKey) {
			// Check if this key matches the current one by comparing the last 8 chars
			// This is a heuristic check since we don't have the full key ID on the client
			// The server will enforce the proper check
			// For now, we'll just show all keys as changeable except the first key
		}

		return true;
	};

	const stats = statsResponse?.data;
	const apiKeys = apiKeysResponse?.data || [];

	return (
		<div className="space-y-4">
			<RoutePageHeader
				page="keys"
				actions={
					<Dialog
						open={isCreateDialogOpen}
						onOpenChange={(open) => {
							setIsCreateDialogOpen(open);
							if (!open) generateKeyMutation.reset();
						}}
					>
						<DialogTrigger asChild>
							<Button size="touch">
								<Plus />
								Generate API Key
							</Button>
						</DialogTrigger>
						<DialogContent>
							<DialogHeader>
								<DialogTitle>Generate New API Key</DialogTitle>
								<DialogDescription>
									Create a new API key for authentication. The key will be shown
									only once, so save it securely.
								</DialogDescription>
							</DialogHeader>
							<div className="space-y-4 py-4">
								<div className="space-y-2">
									<Label htmlFor="name">Key Name</Label>
									<Input
										className="h-11"
										id="name"
										placeholder="e.g., Production App, Development Key"
										value={newKeyName}
										onChange={(e) => setNewKeyName(e.target.value)}
									/>
								</div>
								{(() => {
									const isFirstKey = !stats || stats.active === 0;
									return (
										<>
											<div className="flex items-center space-x-2">
												<input
													type="checkbox"
													id="admin"
													checked={isAdminKey}
													onChange={(e) => setIsAdminKey(e.target.checked)}
													disabled={isFirstKey}
													className="h-4 w-4 rounded border-border disabled:cursor-not-allowed disabled:opacity-60"
												/>
												<Label
													htmlFor="admin"
													className={`flex min-h-11 items-center text-sm font-normal ${isFirstKey ? "cursor-not-allowed opacity-70" : "cursor-pointer"}`}
												>
													Grant admin access (dashboard management)
												</Label>
											</div>
											{isFirstKey ? (
												<Notice tone="warning">
													First API key must be admin to prevent lockout from
													the dashboard.
												</Notice>
											) : isAdminKey ? (
												<Notice tone="warning">
													Admin keys can manage accounts, view analytics, and
													modify settings.
												</Notice>
											) : null}
										</>
									);
								})()}
								{generateKeyMutation.isError && (
									<Notice tone="danger">
										{generateKeyMutation.error?.message ??
											"Failed to generate API key."}
									</Notice>
								)}
							</div>
							<DialogFooter>
								<Button
									size="touch"
									onClick={() => {
										setIsCreateDialogOpen(false);
										generateKeyMutation.reset();
									}}
									variant="outline"
								>
									Cancel
								</Button>
								<Button
									size="touch"
									onClick={handleGenerateKey}
									disabled={!newKeyName.trim() || generateKeyMutation.isPending}
								>
									{generateKeyMutation.isPending
										? "Generating..."
										: "Generate Key"}
								</Button>
							</DialogFooter>
						</DialogContent>
					</Dialog>
				}
			/>
			<div className="space-y-6">
				{/* Statistics Cards */}
				{statsResponse === undefined ? (
					isStatsError ? (
						<ErrorState
							size="inline"
							title="API key statistics could not load"
							message={formatError(statsError)}
							onRetry={() => void refetchStats()}
						/>
					) : (
						<LoadingState size="inline" label="Loading API key statistics" />
					)
				) : (
					<div className="grid grid-cols-1 md:grid-cols-3 gap-4">
						<StatTile label="Total Keys" value={stats?.total || 0} />
						<StatTile
							label="Active Keys"
							value={stats?.active || 0}
							valueClassName="text-success"
						/>
						<StatTile
							label="Inactive Keys"
							value={stats?.inactive || 0}
							valueClassName="text-muted-foreground"
						/>
					</div>
				)}

				<p className="text-muted-foreground">
					When at least one key is active, all API requests must include a valid
					API key.
				</p>

				{/* API Keys List */}
				<Card>
					<CardHeader>
						<CardTitle>Your API Keys</CardTitle>
						{apiKeysResponse !== undefined && (
							<CardDescription>
								{apiKeys.length === 0
									? "No API keys have been created yet."
									: `You have ${apiKeys.length} API key${apiKeys.length === 1 ? "" : "s"}.`}
							</CardDescription>
						)}
					</CardHeader>
					<CardContent>
						{(updateRoleMutation.isError || toggleKeyMutation.isError) && (
							<Notice
								tone="danger"
								className="mb-4"
								action={
									<Button
										type="button"
										variant="ghost"
										size="touch-icon"
										onClick={() => {
											updateRoleMutation.reset();
											toggleKeyMutation.reset();
										}}
										className="-my-2 shrink-0 hover:opacity-70"
										aria-label="Dismiss error"
									>
										<X />
									</Button>
								}
							>
								{updateRoleMutation.error?.message ??
									toggleKeyMutation.error?.message ??
									"Operation failed."}
							</Notice>
						)}
						{apiKeysResponse === undefined ? (
							isKeysError ? (
								<ErrorState
									size="inline"
									title="API keys could not load"
									message={formatError(keysError)}
									onRetry={() => void refetchKeys()}
								/>
							) : (
								<LoadingState size="inline" label="Loading API keys" />
							)
						) : apiKeys.length === 0 ? (
							<EmptyState
								size="inline"
								title="No API keys configured"
								description="API authentication will be disabled until you create your first key."
							/>
						) : (
							<div className="space-y-4">
								{apiKeys.map((key) => (
									<div
										key={key.id}
										className="flex flex-col gap-3 p-4 border rounded-lg sm:flex-row sm:items-center sm:justify-between"
									>
										<div className="min-w-0 flex-1">
											<div className="flex flex-wrap items-center gap-2">
												<h3 className="font-medium break-all">{key.name}</h3>
												<StatusPill tone={key.isActive ? "success" : "neutral"}>
													{key.isActive ? "Active" : "Disabled"}
												</StatusPill>
												{canChangeRole(key) ? (
													<DropdownMenu>
														<DropdownMenuTrigger asChild>
															<Button
																type="button"
																variant="ghost"
																size="touch-sm"
																className="px-1"
																disabled={updateRoleMutation.isPending}
															>
																<StatusPill tone={ROLE_TONE[key.role]}>
																	{key.role === "admin" ? "Admin" : "API-only"}
																</StatusPill>
																<ChevronDown />
															</Button>
														</DropdownMenuTrigger>
														<DropdownMenuContent align="start">
															<DropdownMenuItem
																className="min-h-11"
																onClick={() => handleUpdateRole(key, "admin")}
																disabled={key.role === "admin"}
															>
																<Shield className="h-4 w-4 mr-2" />
																Admin (dashboard access)
															</DropdownMenuItem>
															<DropdownMenuItem
																className="min-h-11"
																onClick={() =>
																	handleUpdateRole(key, "api-only")
																}
																disabled={key.role === "api-only"}
															>
																API-only (proxy access)
															</DropdownMenuItem>
														</DropdownMenuContent>
													</DropdownMenu>
												) : (
													<StatusPill
														tone={ROLE_TONE[key.role]}
														title="First API key must remain admin"
													>
														{key.role === "admin" ? "Admin" : "API-only"}
													</StatusPill>
												)}
											</div>
											<div className="text-sm text-muted-foreground mt-1">
												Key ends with:{" "}
												<code className="bg-muted px-1 rounded">
													{key.prefixLast8}
												</code>
											</div>
											<div className="text-xs text-muted-foreground mt-1">
												Created{" "}
												{formatDistanceToNow(new Date(key.createdAt), {
													addSuffix: true,
												})}
												{key.lastUsed && (
													<>
														{" • "}Last used{" "}
														{formatDistanceToNow(new Date(key.lastUsed), {
															addSuffix: true,
														})}
													</>
												)}
												{" • "}Used {key.usageCount} time
												{key.usageCount !== 1 ? "s" : ""}
											</div>
										</div>
										<div className="flex shrink-0 items-center gap-2">
											<CopyButton
												variant="outline"
												size="touch-icon"
												value={key.prefixLast8}
												title={`Copy key ending ${key.prefixLast8}`}
												label={`Copy key ending ${key.prefixLast8}`}
											/>
											<Button
												variant="outline"
												size="touch-icon"
												onClick={() => handleToggleKey(key, !key.isActive)}
												disabled={toggleKeyMutation.isPending}
												aria-label={`${key.isActive ? "Disable" : "Enable"} ${key.name}`}
												title={key.isActive ? "Disable key" : "Enable key"}
											>
												{key.isActive ? <ToggleLeft /> : <ToggleRight />}
											</Button>
											<Button
												variant="outline"
												size="touch-icon"
												onClick={() => handleDeleteKey(key)}
												disabled={deleteKeyMutation.isPending}
												aria-label={`Delete ${key.name}`}
												title="Delete key"
											>
												<Trash2 className="text-destructive" />
											</Button>
										</div>
									</div>
								))}
							</div>
						)}
					</CardContent>
				</Card>

				{/* Generated Key Dialog */}
				<Dialog
					open={!!generatedKey}
					onOpenChange={(open) => {
						if (!open) {
							setGeneratedKey(null);
							// Trigger auth dialog when closing so user can authenticate
							window.dispatchEvent(new CustomEvent("auth-required"));
						}
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>API Key Generated</DialogTitle>
							<DialogDescription>
								Your API key has been generated. Save it securely now - it won't
								be shown again.
							</DialogDescription>
						</DialogHeader>
						<div className="space-y-4 py-4">
							<div className="space-y-2">
								<Label>API Key</Label>
								<div className="flex items-center gap-2">
									<code className="flex-1 p-3 bg-muted rounded text-sm font-mono break-all">
										{generatedKey}
									</code>
									<CopyButton
										variant="outline"
										size="touch-icon"
										value={generatedKey ?? ""}
										label="Copy API key"
									/>
								</div>
							</div>
							<Notice tone="warning" title="Important:">
								Save this API key in a secure location. You won't be able to see
								it again after closing this dialog.
							</Notice>
						</div>
						<DialogFooter>
							<Button size="touch" onClick={handleSavedKey} variant="outline">
								I've saved the key
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>

				{/* Delete Confirmation Dialog */}
				<Dialog
					open={isDeleteDialogOpen}
					onOpenChange={(open) => {
						setIsDeleteDialogOpen(open);
						if (!open) deleteKeyMutation.reset();
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>Delete API Key</DialogTitle>
							<DialogDescription>
								Are you sure you want to delete the API key "{selectedKey?.name}
								"? This action cannot be undone.
							</DialogDescription>
						</DialogHeader>
						<div className="py-4">
							<p className="text-sm text-muted-foreground">
								Deleting this API key will immediately invalidate it, and any
								applications using it will no longer be able to authenticate.
							</p>
						</div>
						{deleteKeyMutation.isError && (
							<Notice tone="danger">
								{deleteKeyMutation.error?.message ??
									"Failed to delete API key."}
							</Notice>
						)}
						<DialogFooter>
							<Button
								size="touch"
								onClick={() => {
									setIsDeleteDialogOpen(false);
									deleteKeyMutation.reset();
								}}
								variant="outline"
							>
								Cancel
							</Button>
							<Button
								size="touch"
								onClick={confirmDeleteKey}
								variant="destructive"
								disabled={deleteKeyMutation.isPending}
							>
								{deleteKeyMutation.isPending ? "Deleting..." : "Delete Key"}
							</Button>
						</DialogFooter>
					</DialogContent>
				</Dialog>
			</div>
		</div>
	);
}
