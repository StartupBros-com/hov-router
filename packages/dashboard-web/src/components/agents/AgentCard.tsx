import type { Agent } from "@better-ccflare/types";
import { Bot, Cpu, Edit3, Folder, Globe, Sparkles } from "lucide-react";
import { useState } from "react";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import {
	Card,
	CardContent,
	CardDescription,
	CardHeader,
	CardTitle,
} from "../ui/card";
import { Label } from "../ui/label";
import { StatusPill } from "../ui/status-pill";
import { AgentEditDialog } from "./AgentEditDialog";
import { AgentModelPreferenceSelect } from "./AgentModelPreferenceSelect";
import { agentColorClasses } from "./agent-colors";

interface AgentCardProps {
	agent: Agent;
}

export function AgentCard({ agent }: AgentCardProps) {
	const [editDialogOpen, setEditDialogOpen] = useState(false);

	const colors = agentColorClasses(agent.color);
	const isWorkspaceAgent = agent.source === "workspace";
	const isPluginAgent = agent.source === "plugin";
	const SourceIcon = isWorkspaceAgent ? Folder : Globe;

	// Get clean agent name (remove workspace prefix for workspace agents)
	const displayName =
		isWorkspaceAgent && agent.id.includes(":") ? agent.name : agent.name;

	// Get workspace name from ID if it's a workspace agent
	const workspaceName =
		isWorkspaceAgent && agent.id.includes(":") ? agent.id.split(":")[0] : null;

	return (
		<Card
			className={`group relative overflow-hidden transition-all hover:shadow-lg ${colors.border} border-2`}
		>
			{/* Gradient background overlay */}
			<div className={`absolute inset-0 ${colors.bg} opacity-50`} />

			<CardHeader className="relative">
				<div className="space-y-3">
					<div className="flex items-start justify-between gap-2">
						<div className="flex min-w-0 items-center gap-3">
							<div
								className={`shrink-0 p-2.5 rounded-xl ${colors.bg} ${colors.border} border backdrop-blur-sm`}
							>
								<Bot className={`h-5 w-5 ${colors.icon}`} />
							</div>
							<div className="min-w-0 flex-1">
								<CardTitle className="text-base font-semibold flex items-center gap-2 break-words">
									{displayName}
									{agent.model?.includes("opus") && (
										<Sparkles
											className="h-4 w-4 text-(--warning)"
											aria-hidden="true"
										/>
									)}
								</CardTitle>
								<div className="mt-1 flex flex-wrap items-center gap-2">
									<Badge variant="outline" className="text-xs gap-1">
										<SourceIcon className="h-3 w-3" />
										{isWorkspaceAgent ? workspaceName : "Global"}
									</Badge>
									{agent.model?.includes("opus") && (
										<StatusPill tone="secondary">
											<Cpu className="h-3 w-3" />
											Premium
										</StatusPill>
									)}
									{agent.modelSource === "frontmatter" && (
										<StatusPill tone="neutral">Default</StatusPill>
									)}
									{agent.modelSource === "inherit" && (
										<StatusPill tone="neutral">Inherited</StatusPill>
									)}
									{agent.modelSource === "preference" && (
										<StatusPill tone="primary">Override</StatusPill>
									)}
								</div>
							</div>
						</div>
						<Button
							variant="ghost"
							size="touch-icon"
							onClick={() => setEditDialogOpen(true)}
							disabled={isPluginAgent}
							aria-label={`Edit ${displayName}`}
							title={
								isPluginAgent
									? "Plugin-managed agents cannot be edited — modify the source plugin instead"
									: "Edit agent file"
							}
							className="shrink-0 disabled:cursor-not-allowed"
						>
							<Edit3 className="h-4 w-4" />
						</Button>
					</div>
					<CardDescription className="text-sm leading-relaxed line-clamp-3 whitespace-pre-wrap">
						{agent.description.replace(/\\n/g, "\n")}
					</CardDescription>
				</div>
			</CardHeader>

			<CardContent className="relative space-y-4">
				<div className="space-y-2">
					<Label className="text-muted-foreground">Model Preference</Label>
					<AgentModelPreferenceSelect
						agent={agent}
						triggerClassName="h-11 w-full bg-background/60 backdrop-blur-sm"
					/>
					<p className="text-xs text-muted-foreground">
						Proxy override — applies instantly, never modifies the agent file.
					</p>
				</div>

				<div className="pt-2 border-t">
					<p className="text-xs text-muted-foreground font-mono">{agent.id}</p>
				</div>
			</CardContent>

			<AgentEditDialog
				agent={agent}
				open={editDialogOpen}
				onOpenChange={setEditDialogOpen}
			/>
		</Card>
	);
}
