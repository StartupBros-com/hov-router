/**
 * Exact managed-routing surface shared with the packaged CLI help.
 */
export function getManagedRoutingHelpText(): string {
	return `Managed routing (live server; admin key is read only from BETTER_CCFLARE_ADMIN_API_KEY):
  routing list [--api-url <loopback-url>] [--json]
  routing detail <account-id> [--api-url <loopback-url>] [--json]
  routing preview <family> [--managed-model <model>] [--api-url <loopback-url>] [--json]
  routing apply <family> --preview-id <id> --proposal-id <id> --managed-model <model> --yes [--api-url <loopback-url>] [--json]
  routing manual <family> --yes [--api-url <loopback-url>] [--json]

  Families: fable, opus, sonnet, haiku
  Interactive apply may omit the reviewed tuple to preview, review exact deltas,
  select a proposal explicitly, and confirm. JSON and non-interactive mutations
  require every displayed identifier/model plus --yes.
  After interactive account creation, each selected family is freshly previewed,
  reviewed, and confirmed before its account-scoped write. Non-interactive account
  creation prints the immutable account ID and follow-up commands without routing writes.`;
}
