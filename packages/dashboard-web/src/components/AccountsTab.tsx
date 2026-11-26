import type { AccountRoutingOverview } from "@hov-router/types";
import { formatClockTime } from "@hov-router/ui-common";
import { Plus } from "lucide-react";
import { useState } from "react";
import { type Account, api } from "../api";
import {
	ACCOUNT_REAUTH_INVALIDATION,
	ACCOUNT_ROUTING_INVALIDATION,
	FULL_MANAGED_ROUTING_INVALIDATION,
	type ManagedRoutingInvalidationOptions,
	useAccountRoutingOverview,
	useAccounts,
	useBankedResets,
	useForceResetRateLimit,
	useManagedRoutingInvalidation,
	usePauseAccount,
	useRedeemReset,
	useRefreshUsage,
	useRemoveAccount,
	useRenameAccount,
	useResumeAccount,
	useUpdateAccountBillingType,
	useUpdateAccountCustomEndpoint,
	useUpdateAccountModelMappings,
	useUpdateAccountPriority,
} from "../hooks/queries";
import { useApiError } from "../hooks/useApiError";
import {
	AccountAddForm,
	AccountCustomEndpointDialog,
	AccountList,
	AccountModelMappingsDialog,
	AccountPriorityDialog,
	AnthropicReauthDialog,
	BankedResetsSummary,
	CodexReauthDialog,
	DeleteConfirmationDialog,
	PublicValueDialog,
	QwenReauthDialog,
	RenameAccountDialog,
	UseResetDialog,
} from "./accounts";
import type { AccountCreationIdentity } from "./accounts/AccountAddForm";
import {
	type AccountFamilyRoutingState,
	getAccountFamilyRoutingStates,
} from "./accounts/account-routing";
import {
	savePublicValue,
	togglePublicValue,
} from "./accounts/public-value-actions";
import { PageLoading, RoutePageHeader } from "./page-shell";
import { Button } from "./ui/button";
import { Card, CardContent } from "./ui/card";
import { ErrorState } from "./ui/state";

type AccountCreationClient = Pick<
	typeof api,
	| "completeAddAccount"
	| "addVertexAIAccount"
	| "addBedrockAccount"
	| "addZaiAccount"
	| "addMinimaxAccount"
	| "addDeepseekAccount"
	| "addMetaAccount"
	| "addNanoGPTAccount"
	| "addAlibabaCodingPlanAccount"
	| "addKiloAccount"
	| "addOpenRouterAccount"
	| "addAnthropicCompatibleAccount"
	| "addOpenAIAccount"
	| "addOllamaAccount"
	| "addOllamaCloudAccount"
>;

async function immutableAccountIdentity(
	operation: () => Promise<{ accountId: string }>,
	afterCreate: () => Promise<void>,
	onError?: (error: unknown) => void,
): Promise<AccountCreationIdentity> {
	let response: { accountId: string };
	try {
		response = await operation();
	} catch (error) {
		onError?.(error);
		throw error;
	}
	try {
		await afterCreate();
	} catch (error) {
		onError?.(error);
	}
	return { accountId: response.accountId };
}

type RoutingSettingClient = Pick<
	typeof api,
	| "updateAccountAutoFallback"
	| "updateAccountAutoPauseOnOverage"
	| "updateAccountCodexCreditDrain"
	| "updateAccountPeakHoursPause"
>;

/**
 * The Details switches that change how routing treats an account. After each
 * write the routing views refresh along with the account records; refetching
 * accounts alone left the row's routing notices stale (#866).
 */
export function createRoutingSettingToggles(
	client: RoutingSettingClient,
	invalidate: (options: ManagedRoutingInvalidationOptions) => Promise<unknown>,
) {
	const afterWrite = async (write: Promise<unknown>) => {
		await write;
		await invalidate(ACCOUNT_ROUTING_INVALIDATION);
	};
	return {
		autoFallback: (account: Account) =>
			afterWrite(
				client.updateAccountAutoFallback(
					account.id,
					!account.autoFallbackEnabled,
				),
			),
		autoPauseOnOverage: (account: Account) =>
			afterWrite(
				client.updateAccountAutoPauseOnOverage(
					account.id,
					!account.autoPauseOnOverageEnabled,
				),
			),
		codexCreditDrain: (account: Account) =>
			afterWrite(
				client.updateAccountCodexCreditDrain(
					account.id,
					!account.codexCreditDrainEnabled,
				),
			),
		peakHoursPause: (account: Account) =>
			afterWrite(
				client.updateAccountPeakHoursPause(
					account.id,
					!account.peakHoursPauseEnabled,
				),
			),
	};
}

export function createAccountCreationCallbacks(
	client: AccountCreationClient,
	afterCreate: () => Promise<void> = async () => undefined,
	onError?: (error: unknown) => void,
) {
	return {
		onCompleteAccount: (
			params: Parameters<typeof client.completeAddAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.completeAddAccount(params),
				afterCreate,
				onError,
			),
		onAddVertexAIAccount: (
			params: Parameters<typeof client.addVertexAIAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addVertexAIAccount(params),
				afterCreate,
				onError,
			),
		onAddBedrockAccount: (
			params: Parameters<typeof client.addBedrockAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addBedrockAccount(params),
				afterCreate,
				onError,
			),
		onAddZaiAccount: (params: Parameters<typeof client.addZaiAccount>[0]) =>
			immutableAccountIdentity(
				() => client.addZaiAccount(params),
				afterCreate,
				onError,
			),
		onAddMinimaxAccount: (
			params: Parameters<typeof client.addMinimaxAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addMinimaxAccount(params),
				afterCreate,
				onError,
			),
		onAddDeepseekAccount: (
			params: Parameters<typeof client.addDeepseekAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addDeepseekAccount(params),
				afterCreate,
				onError,
			),
		onAddMetaAccount: (params: Parameters<typeof client.addMetaAccount>[0]) =>
			immutableAccountIdentity(
				() => client.addMetaAccount(params),
				afterCreate,
				onError,
			),
		onAddNanoGPTAccount: (
			params: Parameters<typeof client.addNanoGPTAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addNanoGPTAccount(params),
				afterCreate,
				onError,
			),
		onAddAlibabaCodingPlanAccount: (
			params: Parameters<typeof client.addAlibabaCodingPlanAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addAlibabaCodingPlanAccount(params),
				afterCreate,
				onError,
			),
		onAddKiloAccount: (params: Parameters<typeof client.addKiloAccount>[0]) =>
			immutableAccountIdentity(
				() => client.addKiloAccount(params),
				afterCreate,
				onError,
			),
		onAddOpenRouterAccount: (
			params: Parameters<typeof client.addOpenRouterAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOpenRouterAccount(params),
				afterCreate,
				onError,
			),
		onAddAnthropicCompatibleAccount: (
			params: Parameters<typeof client.addAnthropicCompatibleAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addAnthropicCompatibleAccount(params),
				afterCreate,
				onError,
			),
		onAddOpenAIAccount: (
			params: Parameters<typeof client.addOpenAIAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOpenAIAccount(params),
				afterCreate,
				onError,
			),
		onAddOllamaAccount: (
			params: Parameters<typeof client.addOllamaAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOllamaAccount(params),
				afterCreate,
				onError,
			),
		onAddOllamaCloudAccount: (
			params: Parameters<typeof client.addOllamaCloudAccount>[0],
		) =>
			immutableAccountIdentity(
				() => client.addOllamaCloudAccount(params),
				afterCreate,
				onError,
			),
	};
}

export function buildRoutingByAccountId(
	accountIds: readonly string[],
	overview: AccountRoutingOverview | undefined,
): Record<string, readonly AccountFamilyRoutingState[]> {
	const routingByAccountId: Record<
		string,
		readonly AccountFamilyRoutingState[]
	> = {};
	for (const accountId of accountIds) {
		routingByAccountId[accountId] = overview
			? getAccountFamilyRoutingStates(accountId, overview)
			: [];
	}
	return routingByAccountId;
}

/** Catch Details setting failures while keeping the page fallback visible. */
export async function runAccountSetting(
	accountId: string,
	operation: () => Promise<unknown>,
	setSettingsError: (accountId: string, error: string | null) => void,
	setPageError: (error: string | null) => void,
	formatError: (error: unknown) => string,
): Promise<void> {
	setSettingsError(accountId, null);
	setPageError(null);
	try {
		await operation();
		setSettingsError(accountId, null);
	} catch (error) {
		const message = formatError(error);
		setSettingsError(accountId, message);
		setPageError(message);
	}
}

export function AccountsTab() {
	const { formatError } = useApiError();
	const {
		data: accounts,
		dataUpdatedAt: accountsLoadedAt,
		isLoading: loading,
		isFetching: accountsFetching,
		error,
		refetch: loadAccounts,
	} = useAccounts();
	const { data: routingOverview } = useAccountRoutingOverview();
	const { data: bankedResets } = useBankedResets();
	const routingByAccountId = buildRoutingByAccountId(
		accounts?.map((account) => account.id) ?? [],
		routingOverview,
	);
	const invalidateManagedRouting = useManagedRoutingInvalidation();
	const removeAccount = useRemoveAccount();
	const pauseAccount = usePauseAccount();
	const resumeAccount = useResumeAccount();
	const forceResetRateLimit = useForceResetRateLimit();
	const refreshUsage = useRefreshUsage();
	const redeemReset = useRedeemReset();
	const renameAccount = useRenameAccount();
	const updatePriority = useUpdateAccountPriority();
	const updateBillingType = useUpdateAccountBillingType();
	const updateCustomEndpoint = useUpdateAccountCustomEndpoint();
	const updateModelMappings = useUpdateAccountModelMappings();

	const [adding, setAdding] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState<{
		show: boolean;
		accountId: string;
		accountName: string;
		confirmInput: string;
	}>({
		show: false,
		accountId: "",
		accountName: "",
		confirmInput: "",
	});
	const [renameDialog, setRenameDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [publicValueDialog, setPublicValueDialog] = useState<{
		account: Account | null;
		error: string | null;
		isSaving: boolean;
	}>({ account: null, error: null, isSaving: false });
	const [priorityDialog, setPriorityDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [customEndpointDialog, setCustomEndpointDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [modelMappingsDialog, setModelMappingsDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [qwenReauthDialog, setQwenReauthDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [anthropicReauthDialog, setAnthropicReauthDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	const [codexReauthDialog, setCodexReauthDialog] = useState<{
		isOpen: boolean;
		account: Account | null;
	}>({
		isOpen: false,
		account: null,
	});
	// The account as it was when Use reset was opened. A refetch after the
	// answer must not unmount the dialog that is showing it.
	const [useResetAccount, setUseResetAccount] = useState<Account | null>(null);
	const [actionError, setActionError] = useState<string | null>(null);
	const [settingsErrors, setSettingsErrors] = useState<
		Record<string, string | null>
	>({});
	const setSettingsError = (accountId: string, message: string | null) => {
		setSettingsErrors((previous) => ({ ...previous, [accountId]: message }));
	};
	const clearSettingsError = (accountId: string) =>
		setSettingsError(accountId, null);
	const runSetting = (account: Account, operation: () => Promise<unknown>) =>
		runAccountSetting(
			account.id,
			operation,
			setSettingsError,
			setActionError,
			formatError,
		);

	const routingSettingToggles = createRoutingSettingToggles(
		api,
		invalidateManagedRouting,
	);

	const accountCreationCallbacks = createAccountCreationCallbacks(
		api,
		() => invalidateManagedRouting(FULL_MANAGED_ROUTING_INVALIDATION),
		(err) => setActionError(formatError(err)),
	);

	const handleAddAccount = async (params: {
		name: string;
		mode:
			| "claude-oauth"
			| "console"
			| "zai"
			| "minimax"
			| "deepseek"
			| "anthropic-compatible"
			| "openai-compatible"
			| "nanogpt"
			| "vertex-ai"
			| "bedrock"
			| "kilo"
			| "openrouter"
			| "alibaba-coding-plan"
			| "codex"
			| "qwen"
			| "ollama";
		priority: number;
		customEndpoint?: string;
	}) => {
		try {
			const result = await api.initAddAccount(params);
			setActionError(null);
			return result;
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAddVertexAIAccount = async (params: {
		name: string;
		projectId: string;
		region: string;
		priority: number;
	}) => {
		return accountCreationCallbacks.onAddVertexAIAccount(params);
	};

	const handleAddBedrockAccount = async (params: {
		name: string;
		profile: string;
		region: string;
		priority: number;
		cross_region_mode?: "geographic" | "global" | "regional";
		customModel?: string;
	}) => {
		return accountCreationCallbacks.onAddBedrockAccount(params);
	};

	const handleCompleteAccount = async (params: {
		sessionId: string;
		code: string;
	}) => {
		return accountCreationCallbacks.onCompleteAccount(params);
	};

	const handleAddZaiAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddZaiAccount(params);
	};

	const handleAddOpenAIAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOpenAIAccount(params);
	};

	const handleAddMinimaxAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
	}) => {
		return accountCreationCallbacks.onAddMinimaxAccount(params);
	};

	const handleAddDeepseekAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => accountCreationCallbacks.onAddDeepseekAccount(params);

	const handleAddMetaAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddMetaAccount(params);
	};

	const handleAddNanoGPTAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddNanoGPTAccount(params);
	};

	const handleAddAlibabaCodingPlanAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddAlibabaCodingPlanAccount(params);
	};

	const handleAddKiloAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddKiloAccount(params);
	};

	const handleAddOpenRouterAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOpenRouterAccount(params);
	};

	const handleAddAnthropicCompatibleAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddAnthropicCompatibleAccount(params);
	};

	const handleAddOllamaAccount = async (params: {
		name: string;
		priority: number;
		customEndpoint?: string;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOllamaAccount(params);
	};

	const handleAddOllamaCloudAccount = async (params: {
		name: string;
		apiKey: string;
		priority: number;
		modelMappings?: { [key: string]: string };
	}) => {
		return accountCreationCallbacks.onAddOllamaCloudAccount(params);
	};

	const handleRemoveAccount = (account: Account) => {
		setConfirmDelete({
			show: true,
			accountId: account.id,
			accountName: account.name,
			confirmInput: "",
		});
	};

	const handleConfirmDelete = async () => {
		const target = confirmDelete;
		if (target.confirmInput !== target.accountName)
			throw new Error(
				"Account name does not match. Please type the exact account name.",
			);
		if (!target.accountId)
			throw new Error("Missing account id; cannot delete.");
		await removeAccount.mutateAsync({
			id: target.accountId,
			name: target.accountName,
			confirmInput: target.confirmInput,
		});
		setConfirmDelete((current) =>
			current === target
				? { show: false, accountId: "", accountName: "", confirmInput: "" }
				: current,
		);
	};

	const handleRename = (account: Account) => {
		setRenameDialog({ isOpen: true, account });
	};

	const handleConfirmRename = async (newName: string) => {
		if (!renameDialog.account) return;
		await renameAccount.mutateAsync({
			accountId: renameDialog.account.id,
			newName,
		});
	};

	const handlePauseToggle = async (account: Account) => {
		try {
			if (account.paused) {
				await resumeAccount.mutateAsync(account.id);
			} else {
				await pauseAccount.mutateAsync(account.id);
			}
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleForceResetRateLimit = async (account: Account) => {
		try {
			await forceResetRateLimit.mutateAsync(account.id);
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleRefreshUsage = async (
		account: Account,
	): Promise<string | null> => {
		try {
			// The endpoint answers 200 even when the refresh failed (`success:
			// false` plus a reason), so discarding the body makes a failed refresh
			// indistinguishable from a successful one — the button just appears to
			// do nothing. The row that was pressed shows the reason, beside the
			// usage it tried to refresh; the mutation hook still invalidates
			// managed routing.
			const result = await refreshUsage.mutateAsync(account.id);
			return result.success ? null : result.message;
		} catch (err) {
			return formatError(err);
		}
	};

	const handlePriorityChange = (account: Account) => {
		setPriorityDialog({ isOpen: true, account });
	};

	const handleUpdatePriority = async (accountId: string, priority: number) => {
		try {
			await updatePriority.mutateAsync({ accountId, priority });
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleAutoFallbackToggle = (account: Account) =>
		runSetting(account, () => routingSettingToggles.autoFallback(account));

	const handleBillingTypeToggle = (account: Account) =>
		runSetting(account, async () => {
			await updateBillingType.mutateAsync({
				accountId: account.id,
				billingType: account.billingType === "plan" ? "api" : "plan",
			});
		});

	const handleAutoPauseOnOverageToggle = (account: Account) =>
		runSetting(account, () =>
			routingSettingToggles.autoPauseOnOverage(account),
		);

	const handleCodexCreditDrainToggle = (account: Account) =>
		runSetting(account, () => routingSettingToggles.codexCreditDrain(account));

	const handlePublicValueToggle = (account: Account) =>
		runSetting(account, async () => {
			const outcome = await togglePublicValue(account, api);
			if (outcome.kind === "open-dialog") {
				// Turning on needs a public label first.
				setPublicValueDialog({ account, error: null, isSaving: false });
				return;
			}
			await loadAccounts();
			setActionError(null);
		});

	const handlePublicValueEditLabel = (account: Account) => {
		setPublicValueDialog({ account, error: null, isSaving: false });
	};

	const handlePublicValueSave = async (label: string, plan: string | null) => {
		const account = publicValueDialog.account;
		if (!account) return;
		setPublicValueDialog((s) => ({ ...s, error: null, isSaving: true }));
		const outcome = await savePublicValue(
			account,
			label,
			api,
			formatError,
			plan,
		);
		if (!outcome.ok) {
			setPublicValueDialog((s) => ({
				...s,
				error: outcome.error,
				isSaving: false,
			}));
			return;
		}
		// The write succeeded; close the dialog even if the reload fails.
		setPublicValueDialog({ account: null, error: null, isSaving: false });
		try {
			await loadAccounts();
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handleCustomEndpointChange = (account: Account) => {
		setCustomEndpointDialog({ isOpen: true, account });
	};

	const handleModelMappingsChange = (account: Account) => {
		setModelMappingsDialog({ isOpen: true, account });
	};

	const handleReauth = (account: Account) => {
		setQwenReauthDialog({ isOpen: true, account });
	};

	const handleAnthropicReauth = (account: Account) => {
		setAnthropicReauthDialog({ isOpen: true, account });
	};

	const handleCodexReauth = (account: Account) => {
		setCodexReauthDialog({ isOpen: true, account });
	};

	const handleReauthSuccess = async (closeDialog: () => void) => {
		try {
			// A re-login renews the token and can change which models the
			// server lists for the account.
			await invalidateManagedRouting(ACCOUNT_REAUTH_INVALIDATION);
			closeDialog();
			setActionError(null);
		} catch (err) {
			setActionError(formatError(err));
		}
	};

	const handlePeakHoursPauseToggle = (account: Account) =>
		runSetting(account, () => routingSettingToggles.peakHoursPause(account));

	const handleUpdateCustomEndpoint = async (
		accountId: string,
		customEndpoint: string | null,
	) => {
		try {
			await updateCustomEndpoint.mutateAsync({ accountId, customEndpoint });
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	const handleUpdateModelMappings = async (
		accountId: string,
		modelMappings: { [key: string]: string | string[] },
	) => {
		try {
			await updateModelMappings.mutateAsync({ accountId, modelMappings });
		} catch (err) {
			setActionError(formatError(err));
			throw err;
		}
	};

	if (loading) return <PageLoading page="accounts" />;

	return (
		<div className="space-y-4">
			<RoutePageHeader
				page="accounts"
				actions={
					<>
						<BankedResetsSummary summary={bankedResets} />
						{!adding && (
							<Button
								onClick={() => setAdding(true)}
								size="sm"
								className="min-h-11 text-black hover:text-black"
							>
								<Plus className="mr-2 h-4 w-4" />
								Add Account
							</Button>
						)}
					</>
				}
			/>
			{error && accounts ? (
				// A failed background refresh keeps the last accounts on screen.
				<ErrorState
					size="inline"
					title="Couldn't refresh accounts"
					message={`${formatError(error)} Showing accounts from ${formatClockTime(accountsLoadedAt, Date.now())}.`}
					onRetry={() => void loadAccounts()}
					retryDisabled={accountsFetching}
				/>
			) : error ? (
				<ErrorState
					title="Accounts could not load"
					message={formatError(error)}
					onRetry={() => void loadAccounts()}
					retryDisabled={accountsFetching}
				/>
			) : (
				actionError && (
					<ErrorState title="Action failed" message={actionError} />
				)
			)}

			<Card className="min-w-0 border-0 bg-transparent shadow-none hover:shadow-none">
				{/* Rows provide their own surfaces; the section stays visually open. */}
				<CardContent className="space-y-4 p-0">
					{adding && (
						<AccountAddForm
							onAddAccount={handleAddAccount}
							onCompleteAccount={handleCompleteAccount}
							onAddVertexAIAccount={handleAddVertexAIAccount}
							onAddBedrockAccount={handleAddBedrockAccount}
							onAddZaiAccount={handleAddZaiAccount}
							onAddMinimaxAccount={handleAddMinimaxAccount}
							onAddDeepseekAccount={handleAddDeepseekAccount}
							onAddNanoGPTAccount={handleAddNanoGPTAccount}
							onAddAlibabaCodingPlanAccount={handleAddAlibabaCodingPlanAccount}
							onAddKiloAccount={handleAddKiloAccount}
							onAddOpenRouterAccount={handleAddOpenRouterAccount}
							onAddAnthropicCompatibleAccount={
								handleAddAnthropicCompatibleAccount
							}
							onAddOpenAIAccount={handleAddOpenAIAccount}
							onAddOllamaAccount={handleAddOllamaAccount}
							onAddOllamaCloudAccount={handleAddOllamaCloudAccount}
							onAddMetaAccount={handleAddMetaAccount}
							onCancel={() => {
								setAdding(false);
								setActionError(null);
							}}
							onSuccess={() => {
								setAdding(false);
								setActionError(null);
							}}
							onRoutingChanged={() =>
								invalidateManagedRouting(FULL_MANAGED_ROUTING_INVALIDATION)
							}
							onError={setActionError}
						/>
					)}

					{(accounts || !error) && (
						<AccountList
							settingsErrors={settingsErrors}
							onClearSettingsError={clearSettingsError}
							accounts={accounts}
							routingByAccountId={routingByAccountId}
							onPauseToggle={handlePauseToggle}
							onForceResetRateLimit={handleForceResetRateLimit}
							onRefreshUsage={handleRefreshUsage}
							onRemove={handleRemoveAccount}
							onRename={handleRename}
							onPriorityChange={handlePriorityChange}
							onAutoFallbackToggle={handleAutoFallbackToggle}
							onBillingTypeToggle={handleBillingTypeToggle}
							onAutoPauseOnOverageToggle={handleAutoPauseOnOverageToggle}
							onCodexCreditDrainToggle={handleCodexCreditDrainToggle}
							onPublicValueToggle={handlePublicValueToggle}
							onPublicValueEditLabel={handlePublicValueEditLabel}
							onPeakHoursPauseToggle={handlePeakHoursPauseToggle}
							onCustomEndpointChange={handleCustomEndpointChange}
							onModelMappingsChange={handleModelMappingsChange}
							onReauth={handleReauth}
							onAnthropicReauth={handleAnthropicReauth}
							onCodexReauth={handleCodexReauth}
							onUseReset={setUseResetAccount}
						/>
					)}
				</CardContent>
			</Card>

			{confirmDelete.show && (
				<DeleteConfirmationDialog
					key={confirmDelete.accountId}
					accountName={confirmDelete.accountName}
					confirmInput={confirmDelete.confirmInput}
					onConfirmInputChange={(value) =>
						setConfirmDelete({
							...confirmDelete,
							confirmInput: value,
						})
					}
					onConfirm={handleConfirmDelete}
					onCancel={() => {
						setConfirmDelete({
							show: false,
							accountId: "",
							accountName: "",
							confirmInput: "",
						});
						setActionError(null);
					}}
				/>
			)}

			{renameDialog.isOpen && renameDialog.account && (
				<RenameAccountDialog
					key={renameDialog.account.id}
					isOpen={renameDialog.isOpen}
					currentName={renameDialog.account.name}
					onClose={() =>
						setRenameDialog((current) =>
							current === renameDialog
								? { isOpen: false, account: null }
								: current,
						)
					}
					onRename={handleConfirmRename}
					isLoading={renameAccount.isPending}
				/>
			)}

			{publicValueDialog.account && (
				<PublicValueDialog
					isOpen
					accountName={publicValueDialog.account.name}
					initialLabel={publicValueDialog.account.publicValueLabel ?? ""}
					provider={publicValueDialog.account.provider}
					initialPlan={publicValueDialog.account.publicValuePlan ?? null}
					error={publicValueDialog.error}
					isLoading={publicValueDialog.isSaving}
					onClose={() =>
						setPublicValueDialog({
							account: null,
							error: null,
							isSaving: false,
						})
					}
					onSave={handlePublicValueSave}
				/>
			)}

			{priorityDialog.isOpen && priorityDialog.account && (
				<AccountPriorityDialog
					key={priorityDialog.account.id}
					account={priorityDialog.account}
					isOpen={priorityDialog.isOpen}
					onOpenChange={(open) =>
						setPriorityDialog((current) =>
							current === priorityDialog
								? {
										isOpen: open,
										account: open ? priorityDialog.account : null,
									}
								: current,
						)
					}
					onUpdatePriority={handleUpdatePriority}
				/>
			)}

			{customEndpointDialog.isOpen && customEndpointDialog.account && (
				<AccountCustomEndpointDialog
					key={customEndpointDialog.account.id}
					isOpen={customEndpointDialog.isOpen}
					account={customEndpointDialog.account}
					onOpenChange={(open) =>
						setCustomEndpointDialog((current) =>
							current === customEndpointDialog
								? {
										isOpen: open,
										account: open ? customEndpointDialog.account : null,
									}
								: current,
						)
					}
					onUpdateEndpoint={handleUpdateCustomEndpoint}
				/>
			)}
			{modelMappingsDialog.isOpen && modelMappingsDialog.account && (
				<AccountModelMappingsDialog
					key={modelMappingsDialog.account.id}
					isOpen={modelMappingsDialog.isOpen}
					account={modelMappingsDialog.account}
					onOpenChange={(open) =>
						setModelMappingsDialog((current) =>
							current === modelMappingsDialog
								? {
										isOpen: open,
										account: open ? modelMappingsDialog.account : null,
									}
								: current,
						)
					}
					onUpdateModelMappings={handleUpdateModelMappings}
				/>
			)}
			<QwenReauthDialog
				isOpen={qwenReauthDialog.isOpen}
				account={qwenReauthDialog.account}
				onClose={() => setQwenReauthDialog({ isOpen: false, account: null })}
				onSuccess={() =>
					handleReauthSuccess(() =>
						setQwenReauthDialog({ isOpen: false, account: null }),
					)
				}
			/>
			<AnthropicReauthDialog
				isOpen={anthropicReauthDialog.isOpen}
				account={anthropicReauthDialog.account}
				onClose={() =>
					setAnthropicReauthDialog({ isOpen: false, account: null })
				}
				onSuccess={() =>
					handleReauthSuccess(() =>
						setAnthropicReauthDialog({ isOpen: false, account: null }),
					)
				}
			/>
			<CodexReauthDialog
				isOpen={codexReauthDialog.isOpen}
				account={codexReauthDialog.account}
				onClose={() => setCodexReauthDialog({ isOpen: false, account: null })}
				onSuccess={() =>
					handleReauthSuccess(() =>
						setCodexReauthDialog({ isOpen: false, account: null }),
					)
				}
			/>
			{useResetAccount && (
				// Keyed by account: each opening mints its own request id.
				<UseResetDialog
					key={useResetAccount.id}
					account={useResetAccount}
					redeem={(accountId, requestId) =>
						redeemReset.mutateAsync({ accountId, requestId })
					}
					onClose={() => setUseResetAccount(null)}
				/>
			)}
		</div>
	);
}
