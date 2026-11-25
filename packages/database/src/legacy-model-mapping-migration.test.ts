/**
 * Release 7.0.0 folds custom_endpoint modelMappings and model_fallbacks into
 * model_mappings, drops the model_fallbacks column, and renames the retired
 * upstream_429_no_reset_default_5h reason. Each database vintage runs the
 * migrations twice to prove the step is idempotent.
 */
import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { runMigrations } from "./migrations";

// The trigger 6.4.0 installed on a database that has model_fallbacks, as read
// from a production schema.
const TRIGGER_6_4_0 = `CREATE TRIGGER trg_routing_revision_accounts_update
	AFTER UPDATE OF id, provider, priority, billing_type, model_mappings, model_fallbacks, custom_endpoint, api_key, refresh_token, access_token
	ON accounts
	WHEN OLD.id IS NOT NEW.id OR OLD.provider IS NOT NEW.provider OR OLD.priority IS NOT NEW.priority OR OLD.billing_type IS NOT NEW.billing_type OR OLD.model_mappings IS NOT NEW.model_mappings OR OLD.model_fallbacks IS NOT NEW.model_fallbacks OR OLD.custom_endpoint IS NOT NEW.custom_endpoint OR (length(trim(COALESCE(OLD.api_key, ''))) > 0)
		!= (length(trim(COALESCE(NEW.api_key, ''))) > 0) OR (length(trim(COALESCE(OLD.refresh_token, ''))) > 0)
		!= (length(trim(COALESCE(NEW.refresh_token, ''))) > 0) OR (length(trim(COALESCE(OLD.access_token, ''))) > 0)
		!= (length(trim(COALESCE(NEW.access_token, ''))) > 0)
	BEGIN
		UPDATE routing_policy_revision
		SET revision = revision + 1
		WHERE scope = 'global';
	END`;

function columns(db: Database): string[] {
	return (
		db.prepare("PRAGMA table_info(accounts)").all() as Array<{ name: string }>
	).map((column) => column.name);
}

function updateTriggerSql(db: Database): string | null {
	return (
		(
			db
				.prepare(
					"SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = 'trg_routing_revision_accounts_update'",
				)
				.get() as { sql: string } | null
		)?.sql ?? null
	);
}

function account(db: Database, id: string) {
	return db
		.prepare(
			"SELECT model_mappings, custom_endpoint, rate_limited_reason FROM accounts WHERE id = ?",
		)
		.get(id) as {
		model_mappings: string | null;
		custom_endpoint: string | null;
		rate_limited_reason: string | null;
	} | null;
}

function legacyEndpointRows(db: Database): number {
	return (
		db
			.prepare(
				"SELECT COUNT(*) AS n FROM accounts WHERE custom_endpoint LIKE '%modelMappings%'",
			)
			.get() as { n: number }
	).n;
}

function routingRevision(db: Database): number {
	return (
		db
			.prepare(
				"SELECT revision FROM routing_policy_revision WHERE scope = 'global'",
			)
			.get() as { revision: number }
	).revision;
}

function expectRetiredShape(db: Database): void {
	expect(columns(db)).not.toContain("model_fallbacks");
	const trigger = updateTriggerSql(db);
	expect(trigger).not.toBeNull();
	expect(trigger).not.toContain("model_fallbacks");
	expect(trigger).toContain("model_mappings");
	const before = routingRevision(db);
	db.run(
		'UPDATE accounts SET model_mappings = \'{"haiku":"bump"}\' WHERE rowid = (SELECT MIN(rowid) FROM accounts)',
	);
	expect(routingRevision(db)).toBe(before + 1);
}

describe("legacy model mapping migration", () => {
	it("leaves a fresh database without model_fallbacks", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			runMigrations(db);
			db.run(
				"INSERT INTO accounts (id, name, provider, created_at) VALUES ('f1', 'f1', 'openai-compatible', 1)",
			);
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});

	it("folds a 6.4.0 database and drops the column", () => {
		const db = new Database(":memory:");
		try {
			runMigrations(db);
			db.run("ALTER TABLE accounts ADD COLUMN model_fallbacks TEXT");
			db.run("DROP TRIGGER trg_routing_revision_accounts_update");
			db.run(TRIGGER_6_4_0);
			const insert = db.prepare(
				"INSERT INTO accounts (id, name, provider, created_at, model_mappings, custom_endpoint, model_fallbacks, rate_limited_reason) VALUES (?, ?, ?, 1, ?, ?, ?, ?)",
			);
			insert.run(
				"a1",
				"a1",
				"openai-compatible",
				'{"opus":"a"}',
				'{"endpoint":"https://e.example","modelMappings":{"sonnet":"s"}}',
				'{"opus":"fb"}',
				null,
			);
			insert.run(
				"vertex",
				"vertex",
				"vertex-ai",
				null,
				'{ "projectId": "p", "region": "us-east5" }',
				null,
				null,
			);
			insert.run(
				"five-hour",
				"five-hour",
				"anthropic",
				null,
				null,
				null,
				"upstream_429_no_reset_default_5h",
			);
			insert.run(
				"cooldown",
				"cooldown",
				"anthropic",
				null,
				null,
				null,
				"upstream_429_with_reset",
			);
			// Stripping b1's key would give it b2's (name, provider, endpoint)
			// tuple, which the unique index forbids.
			insert.run(
				"b1",
				"dup",
				"openai-compatible",
				null,
				'{"modelMappings":{"opus":"x"}}',
				null,
				null,
			);
			insert.run("b2", "dup", "openai-compatible", null, "{}", null, null);

			runMigrations(db);
			// Nothing is left for a later start to fold again, so an edit made
			// after the upgrade survives the next start.
			expect(legacyEndpointRows(db)).toBe(0);
			db.run(
				"UPDATE accounts SET model_mappings = '{\"opus\":\"edited\"}' WHERE id = 'b1'",
			);
			runMigrations(db);

			expect(JSON.parse(account(db, "a1")?.model_mappings ?? "null")).toEqual({
				opus: ["a", "fb"],
				sonnet: "s",
			});
			expect(account(db, "a1")?.custom_endpoint).toBe(
				'{"endpoint":"https://e.example"}',
			);
			expect(account(db, "vertex")).toEqual({
				model_mappings: null,
				custom_endpoint: '{ "projectId": "p", "region": "us-east5" }',
				rate_limited_reason: null,
			});
			expect(account(db, "five-hour")?.rate_limited_reason).toBe(
				"upstream_429_no_reset_probe_cooldown",
			);
			expect(account(db, "cooldown")?.rate_limited_reason).toBe(
				"upstream_429_with_reset",
			);
			expect(account(db, "b1")).toEqual({
				model_mappings: '{"opus":"edited"}',
				custom_endpoint: '{"foldedLegacyMappingsFor":"b1"}',
				rate_limited_reason: null,
			});
			expect(account(db, "b2")?.custom_endpoint).toBe("{}");
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});

	it("folds before the nullable refresh_token rebuild", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE accounts (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					provider TEXT DEFAULT 'anthropic',
					api_key TEXT,
					refresh_token TEXT NOT NULL,
					access_token TEXT,
					expires_at INTEGER,
					created_at INTEGER NOT NULL,
					last_used INTEGER,
					request_count INTEGER DEFAULT 0,
					total_requests INTEGER DEFAULT 0,
					priority INTEGER DEFAULT 0,
					custom_endpoint TEXT,
					model_mappings TEXT,
					model_fallbacks TEXT
				)
			`);
			const insert = db.prepare(
				"INSERT INTO accounts (id, name, provider, refresh_token, created_at, custom_endpoint, model_mappings, model_fallbacks) VALUES (?, ?, 'openai-compatible', '', ?, ?, ?, ?)",
			);
			insert.run(
				"c1",
				"c1",
				1,
				'{"endpoint":"https://c.example","modelMappings":{"opus":"o"}}',
				null,
				'{"opus":"ofb","haiku":"h"}',
			);

			runMigrations(db);
			runMigrations(db);

			const refreshToken = (
				db.prepare("PRAGMA table_info(accounts)").all() as Array<{
					name: string;
					notnull: number;
				}>
			).find((column) => column.name === "refresh_token");
			expect(refreshToken?.notnull).toBe(0);
			expect(JSON.parse(account(db, "c1")?.model_mappings ?? "null")).toEqual({
				opus: ["o", "ofb"],
				haiku: "h",
			});
			expect(account(db, "c1")?.custom_endpoint).toBe(
				'{"endpoint":"https://c.example"}',
			);
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});

	it("folds before the duplicate merge", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE accounts (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					provider TEXT DEFAULT 'anthropic',
					api_key TEXT,
					refresh_token TEXT,
					access_token TEXT,
					expires_at INTEGER,
					created_at INTEGER NOT NULL,
					last_used INTEGER,
					request_count INTEGER DEFAULT 0,
					total_requests INTEGER DEFAULT 0,
					priority INTEGER DEFAULT 0,
					custom_endpoint TEXT,
					model_mappings TEXT,
					model_fallbacks TEXT
				)
			`);
			const insert = db.prepare(
				"INSERT INTO accounts (id, name, provider, created_at, model_mappings, model_fallbacks) VALUES (?, 'dup', 'openai-compatible', ?, ?, ?)",
			);
			insert.run("d1", 1, '{"sonnet":"s"}', null);
			insert.run("d2", 2, null, '{"sonnet":"sfb"}');

			runMigrations(db);
			runMigrations(db);

			// Each duplicate's fallback is folded before the merge, and the merge
			// keeps the survivor's own model_mappings (d2, the newer row). Before
			// 7.0.0 the merge also adopted d1's mapping, so sonnet tried s, then sfb.
			const duplicates = db
				.prepare("SELECT model_mappings FROM accounts WHERE name = 'dup'")
				.all() as Array<{ model_mappings: string | null }>;
			expect(duplicates).toEqual([{ model_mappings: '{"sonnet":"sfb"}' }]);
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});

	it("merges exact duplicates that both carry endpoint mappings", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE accounts (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					provider TEXT DEFAULT 'anthropic',
					api_key TEXT,
					refresh_token TEXT,
					access_token TEXT,
					expires_at INTEGER,
					created_at INTEGER NOT NULL,
					last_used INTEGER,
					request_count INTEGER DEFAULT 0,
					total_requests INTEGER DEFAULT 0,
					priority INTEGER DEFAULT 0,
					custom_endpoint TEXT,
					model_mappings TEXT
				)
			`);
			const insert = db.prepare(
				"INSERT INTO accounts (id, name, provider, created_at, custom_endpoint) VALUES (?, 'dup', 'openai-compatible', ?, ?)",
			);
			const endpoint =
				'{"endpoint":"https://e.example","modelMappings":{"opus":"o"}}';
			insert.run("d1", 1, endpoint);
			insert.run("d2", 2, endpoint);

			runMigrations(db);
			runMigrations(db);

			// They were one account before the fold, so they stay one after it.
			expect(
				db
					.prepare(
						"SELECT model_mappings, custom_endpoint FROM accounts WHERE name = 'dup'",
					)
					.all(),
			).toEqual([
				{
					model_mappings: '{"opus":"o"}',
					custom_endpoint: '{"endpoint":"https://e.example"}',
				},
			]);
			expect(legacyEndpointRows(db)).toBe(0);
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});

	it("keeps exact duplicates together when the bare endpoint is taken", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE accounts (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					provider TEXT DEFAULT 'anthropic',
					api_key TEXT,
					refresh_token TEXT,
					access_token TEXT,
					expires_at INTEGER,
					created_at INTEGER NOT NULL,
					last_used INTEGER,
					request_count INTEGER DEFAULT 0,
					total_requests INTEGER DEFAULT 0,
					priority INTEGER DEFAULT 0,
					custom_endpoint TEXT,
					model_mappings TEXT
				)
			`);
			const insert = db.prepare(
				"INSERT INTO accounts (id, name, provider, created_at, custom_endpoint) VALUES (?, 'dup', 'openai-compatible', ?, ?)",
			);
			const endpoint =
				'{"endpoint":"https://e.example","modelMappings":{"opus":"o"}}';
			insert.run("d1", 1, endpoint);
			insert.run("d2", 2, endpoint);
			insert.run("bare", 3, '{"endpoint":"https://e.example"}');

			runMigrations(db);
			runMigrations(db);

			// d1 and d2 get the same marker, so they still merge into one account,
			// and that account stays apart from the one without mappings.
			expect(
				db
					.prepare(
						"SELECT model_mappings, custom_endpoint FROM accounts WHERE name = 'dup' ORDER BY created_at",
					)
					.all(),
			).toEqual([
				{
					model_mappings: '{"opus":"o"}',
					custom_endpoint:
						'{"endpoint":"https://e.example","foldedLegacyMappingsFor":"d1"}',
				},
				{
					model_mappings: null,
					custom_endpoint: '{"endpoint":"https://e.example"}',
				},
			]);
			expect(legacyEndpointRows(db)).toBe(0);
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});

	it("folds before the account_tier rebuild", () => {
		const db = new Database(":memory:");
		try {
			db.exec(`
				CREATE TABLE accounts (
					id TEXT PRIMARY KEY,
					name TEXT NOT NULL,
					provider TEXT DEFAULT 'anthropic',
					api_key TEXT,
					refresh_token TEXT,
					access_token TEXT,
					expires_at INTEGER,
					created_at INTEGER NOT NULL,
					last_used INTEGER,
					request_count INTEGER DEFAULT 0,
					total_requests INTEGER DEFAULT 0,
					priority INTEGER DEFAULT 0,
					custom_endpoint TEXT,
					model_mappings TEXT,
					model_fallbacks TEXT,
					account_tier TEXT DEFAULT 'free'
				)
			`);
			db.run(
				`INSERT INTO accounts (id, name, provider, created_at, model_mappings, model_fallbacks, account_tier)
				 VALUES ('t1', 't1', 'openai-compatible', 1, '{"opus":"o"}', '{"opus":"ofb"}', 'pro')`,
			);

			runMigrations(db);
			runMigrations(db);

			expect(columns(db)).not.toContain("account_tier");
			expect(JSON.parse(account(db, "t1")?.model_mappings ?? "null")).toEqual({
				opus: ["o", "ofb"],
			});
			expectRetiredShape(db);
		} finally {
			db.close();
		}
	});
});
