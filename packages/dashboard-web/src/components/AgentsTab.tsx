import { DEFAULT_AGENT_MODEL } from "@better-ccflare/core";
import { PRODUCT_NAME } from "@better-ccflare/core/product-identity";
import { format, formatDistanceToNow } from "date-fns";
import {
	Folder,
	FolderOpen,
	Globe,
	Package,
	RefreshCw,
	Settings,
} from "lucide-react";
import { useState } from "react";
import {
	useAgents,
	useBulkUpdateAgentPreferences,
	useModels,
	useRefreshModels,
} from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import { AgentCard, ModelSelect, WorkspaceCard } from "./agents";
import { RoutePageHeader } from "./page-shell";
import { Badge } from "./ui/badge";
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
import { Separator } from "./ui/separator";
import { EmptyState, ErrorState, LoadingState } from "./ui/state";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "./ui/tabs";

export function AgentsTab() {
	const { data: response, isError, error, refetch } = useAgents();
	const bulkUpdatePreferences = useBulkUpdateAgentPreferences();
	const refreshModels = useRefreshModels();
	const { data: modelCatalog } = useModels();
	const [selectedWorkspace, setSelectedWorkspace] = useState<string | null>(
		null,
	);
	const [bulkUpdateDialogOpen, setBulkUpdateDialogOpen] = useState(false);
	const [bulkUpdateModel, setBulkUpdateModel] =
		useState<string>(DEFAULT_AGENT_MODEL);

	const handleBulkUpdate = () => {
		bulkUpdatePreferences.mutate(bulkUpdateModel, {
			onSuccess: (_data) => {
				setBulkUpdateDialogOpen(false);
				// You could add a toast notification here
			},
		});
	};

	const { formatError } = useApiError();
	const header = (
		<RoutePageHeader
			page="agents"
			actions={
				response && (
					<>
						<Badge variant="secondary" className="gap-1.5">
							<Globe className="h-3.5 w-3.5" />
							{response.globalAgents.length} Global
						</Badge>
						<Badge variant="secondary" className="gap-1.5">
							<Folder className="h-3.5 w-3.5" />
							{response.workspaceAgents.length} Workspace
						</Badge>
						{response.pluginAgents.length > 0 && (
							<Badge variant="secondary" className="gap-1.5">
								<Package className="h-3.5 w-3.5" />
								{response.pluginAgents.length} Plugin
							</Badge>
						)}
					</>
				)
			}
		/>
	);
	if (response === undefined)
		return (
			<div className="space-y-4">
				{header}
				{isError ? (
					<ErrorState
						title="Agents could not load"
						message={formatError(error)}
						onRetry={() => void refetch()}
					/>
				) : (
					<LoadingState label="Loading agents" />
				)}
			</div>
		);

	if (response.agents.length === 0) {
		return (
			<div className="space-y-4">
				{header}
				<Card>
					<EmptyState
						title="No agents yet"
						description={
							"No agent definition files found in ~/.claude/agents/ or a registered workspace on the machine running " +
							PRODUCT_NAME +
							". Agents on the computers that connect to it are not listed here."
						}
					/>
					<CardContent className="space-y-4">
						<div>
							<h3 className="font-medium mb-2">Global Agents</h3>
							<p className="text-sm text-muted-foreground">
								To add global agents, create markdown files in the
								~/.claude/agents/ directory of the account that runs{" "}
								{PRODUCT_NAME}.
							</p>
						</div>
						<Separator />
						<div>
							<h3 className="font-medium mb-2">Workspace Agents</h3>
							<p className="text-sm text-muted-foreground">
								Workspace agents live in a project's .claude/agents/ directory.{" "}
								{PRODUCT_NAME} registers projects only when
								BETTER_CCFLARE_AGENT_WORKSPACE_AUTODISCOVER=true is set. It then
								registers a project from the next request sent from inside it,
								if that folder is on its own machine under the directory it runs
								from.
							</p>
						</div>
						<Separator />
						<div>
							<h3 className="font-medium mb-2">Agent Format</h3>
							<pre className="mt-2 p-4 bg-muted rounded-lg text-xs overflow-x-auto">
								{`---
name: My Agent
description: Description of what this agent does
color: blue
model: ${DEFAULT_AGENT_MODEL}
---

Your system prompt content here...`}
							</pre>
						</div>
					</CardContent>
				</Card>
			</div>
		);
	}

	const { globalAgents, workspaceAgents, pluginAgents, workspaces } = response;
	const filteredWorkspaceAgents = selectedWorkspace
		? workspaceAgents.filter((agent) => agent.workspace === selectedWorkspace)
		: workspaceAgents;

	// Add agent counts to workspaces
	const workspacesWithCounts = workspaces.map((workspace) => ({
		...workspace,
		agentCount: workspaceAgents.filter((a) => a.workspace === workspace.path)
			.length,
	}));

	return (
		<div className="space-y-4">
			{header}
			<div className="space-y-6">
				<div className="space-y-4">
					<p className="text-xs text-muted-foreground">
						Lists agent files on the machine running {PRODUCT_NAME}, not the
						agents on the computers that connect to it.
					</p>
					<p className="text-xs text-muted-foreground">
						Model preference on a card sets a runtime proxy override (database
						only). Edit opens the agent's configuration file — those changes are
						written to disk.
					</p>
					{/* Agent model preferences */}
					<Card>
						<CardHeader>
							<div className="flex items-center justify-between">
								<div>
									<CardTitle className="text-base flex items-center gap-2">
										<Settings className="h-4 w-4" />
										Agent Model Preferences
									</CardTitle>
									<CardDescription>
										Set every agent's model preference at once.
									</CardDescription>
								</div>
								<div className="flex items-center gap-3">
									{modelCatalog && (
										<span className="text-xs text-muted-foreground">
											{modelCatalog.source === "live"
												? `Live model list · fetched ${formatDistanceToNow(
														new Date(modelCatalog.fetchedAt),
														{ addSuffix: true },
													)}`
												: `Bundled model list · as of ${format(
														new Date(modelCatalog.fetchedAt),
														"PP",
													)}`}
										</span>
									)}
									<Button
										variant="outline"
										size="touch-icon"
										onClick={() => refreshModels.mutate()}
										disabled={refreshModels.isPending}
										aria-label="Refresh model list"
										title="Refresh the live model list from Anthropic"
									>
										<RefreshCw
											className={refreshModels.isPending ? "animate-spin" : ""}
										/>
									</Button>
								</div>
							</div>
						</CardHeader>
						<CardContent>
							<div className="space-y-4">
								<div className="space-y-2">
									<p className="text-sm font-medium">Force Update All Agents</p>
									<p className="text-sm text-muted-foreground">
										Override all individual agent preferences with a specific
										model.
									</p>
									<Dialog
										open={bulkUpdateDialogOpen}
										onOpenChange={setBulkUpdateDialogOpen}
									>
										<DialogTrigger asChild>
											<Button variant="outline" size="touch-sm">
												Force Update All
											</Button>
										</DialogTrigger>
										<DialogContent>
											<DialogHeader>
												<DialogTitle>Update All Agent Models</DialogTitle>
												<DialogDescription>
													This will override all individual agent preferences
													and set them to the selected model. This action cannot
													be undone.
												</DialogDescription>
											</DialogHeader>
											<div className="py-4">
												<ModelSelect
													value={bulkUpdateModel}
													onValueChange={setBulkUpdateModel}
													ariaLabel="Model for all agents"
												/>
											</div>
											<DialogFooter>
												<Button
													variant="outline"
													size="touch"
													onClick={() => setBulkUpdateDialogOpen(false)}
												>
													Cancel
												</Button>
												<Button
													variant="destructive"
													size="touch"
													onClick={handleBulkUpdate}
													disabled={bulkUpdatePreferences.isPending}
												>
													{bulkUpdatePreferences.isPending
														? "Updating..."
														: `Update ${response?.agents.length || 0} Agents`}
												</Button>
											</DialogFooter>
										</DialogContent>
									</Dialog>
								</div>
							</div>
						</CardContent>
					</Card>

					{/* Workspaces Section */}
					{workspacesWithCounts.length > 0 && (
						<Card className="border-dashed">
							<CardHeader>
								<CardTitle className="text-base flex items-center gap-2">
									<FolderOpen className="h-4 w-4" />
									Active Workspaces
								</CardTitle>
							</CardHeader>
							<CardContent>
								<div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
									{workspacesWithCounts.map((workspace) => (
										<button
											type="button"
											key={workspace.path}
											onClick={() =>
												setSelectedWorkspace(
													selectedWorkspace === workspace.path
														? null
														: workspace.path,
												)
											}
											aria-pressed={selectedWorkspace === workspace.path}
											className="text-left w-full"
										>
											<WorkspaceCard
												workspace={workspace}
												isActive={selectedWorkspace === workspace.path}
											/>
										</button>
									))}
								</div>
							</CardContent>
						</Card>
					)}
				</div>

				{/* Agents Tabs */}
				<Tabs defaultValue="all" className="space-y-4">
					<TabsList className="grid h-auto w-full max-w-md grid-cols-3">
						<TabsTrigger value="all" className="min-h-11 gap-1.5">
							<Package className="h-4 w-4" />
							All Agents
						</TabsTrigger>
						<TabsTrigger value="global" className="min-h-11 gap-1.5">
							<Globe className="h-4 w-4" />
							Global
						</TabsTrigger>
						<TabsTrigger value="workspace" className="min-h-11 gap-1.5">
							<Folder className="h-4 w-4" />
							Workspace
						</TabsTrigger>
					</TabsList>

					<TabsContent value="all" className="space-y-6">
						{globalAgents.length > 0 && (
							<div className="space-y-4">
								<div className="flex items-center gap-2">
									<h2 className="text-lg font-semibold">Global Agents</h2>
									<Badge variant="outline">{globalAgents.length}</Badge>
								</div>
								<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
									{globalAgents.map((agent) => (
										<AgentCard key={agent.id} agent={agent} />
									))}
								</div>
							</div>
						)}

						{workspaceAgents.length > 0 && (
							<div className="space-y-4">
								<div className="flex items-center gap-2">
									<h2 className="text-lg font-semibold">Workspace Agents</h2>
									<Badge variant="outline">
										{filteredWorkspaceAgents.length}
									</Badge>
									{selectedWorkspace && (
										<Button
											variant="ghost"
											size="touch-sm"
											onClick={() => setSelectedWorkspace(null)}
										>
											Clear filter
										</Button>
									)}
								</div>
								<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
									{filteredWorkspaceAgents.map((agent) => (
										<AgentCard key={agent.id} agent={agent} />
									))}
								</div>
							</div>
						)}

						{pluginAgents.length > 0 && (
							<div className="space-y-4">
								<div className="flex items-center gap-2">
									<h2 className="text-lg font-semibold">Plugin Agents</h2>
									<Badge variant="outline">{pluginAgents.length}</Badge>
								</div>
								<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
									{pluginAgents.map((agent) => (
										<AgentCard key={agent.id} agent={agent} />
									))}
								</div>
							</div>
						)}
					</TabsContent>

					<TabsContent value="global" className="space-y-4">
						{globalAgents.length === 0 ? (
							<EmptyState
								size="inline"
								title="No Global Agents"
								description="Create agent files in ~/.claude/agents/ to add global agents"
							/>
						) : (
							<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
								{globalAgents.map((agent) => (
									<AgentCard key={agent.id} agent={agent} />
								))}
							</div>
						)}
					</TabsContent>

					<TabsContent value="workspace" className="space-y-4">
						{workspaceAgents.length === 0 ? (
							<EmptyState
								size="inline"
								title="No Workspace Agents"
								description="Workspace agents are automatically discovered from your project directories. They should be able to discover local project agents after you send a message from within that directory."
							/>
						) : (
							<>
								{selectedWorkspace && (
									<div className="flex items-center gap-2 p-3 bg-muted rounded-lg">
										<Folder className="h-4 w-4" />
										<span className="text-sm">
											Showing agents from:{" "}
											<strong>{selectedWorkspace.split("/").pop()}</strong>
										</span>
										<Button
											variant="ghost"
											size="touch-sm"
											className="ml-auto"
											onClick={() => setSelectedWorkspace(null)}
										>
											Clear filter
										</Button>
									</div>
								)}
								<div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
									{filteredWorkspaceAgents.map((agent) => (
										<AgentCard key={agent.id} agent={agent} />
									))}
								</div>
							</>
						)}
					</TabsContent>
				</Tabs>
			</div>
		</div>
	);
}
