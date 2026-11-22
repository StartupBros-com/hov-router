import { BaseRepository } from "./base.repository";

/** The stored route lanes: the JSON array text exactly as written, and its revision. */
export interface StoredRouteProfileConfig {
	readonly raw: string;
	readonly revision: number;
	readonly updatedAt: number;
	/** Who wrote it: `api`, or `import:file` / `import:env` on first start (#971). */
	readonly source: string;
}

export interface SaveRouteProfileConfigInput {
	readonly raw: string;
	/** The revision the caller read; 0 means nothing is stored yet. */
	readonly expectedRevision: number;
	readonly source: string;
	readonly now: number;
}

interface RouteProfileConfigRow {
	profiles_json: string;
	revision: number;
	updated_at: number;
	source: string;
}

/**
 * One global row holding the lane set. The set is validated as a whole by the
 * route-profile parser, so it is stored as one document; every write is a
 * compare-and-swap on `revision` (#971).
 */
export class RouteProfileConfigRepository extends BaseRepository<StoredRouteProfileConfig> {
	async read(): Promise<StoredRouteProfileConfig | null> {
		const row = await this.get<RouteProfileConfigRow>(
			"SELECT profiles_json, revision, updated_at, source FROM route_profile_config WHERE scope = 'global'",
		);
		if (!row) return null;
		return {
			raw: row.profiles_json,
			revision: Number(row.revision),
			updatedAt: Number(row.updated_at),
			source: row.source,
		};
	}

	async readRevision(): Promise<number | null> {
		const row = await this.get<{ revision: number }>(
			"SELECT revision FROM route_profile_config WHERE scope = 'global'",
		);
		return row ? Number(row.revision) : null;
	}

	/** Returns the new revision, or null when the stored revision is not `expectedRevision`. */
	async save(input: SaveRouteProfileConfigInput): Promise<number | null> {
		if (input.expectedRevision === 0) {
			const created = await this.runWithChanges(
				`INSERT OR IGNORE INTO route_profile_config (scope, profiles_json, revision, updated_at, source)
				 VALUES ('global', ?, 1, ?, ?)`,
				[input.raw, input.now, input.source],
			);
			return created === 1 ? 1 : null;
		}
		const updated = await this.runWithChanges(
			`UPDATE route_profile_config
			 SET profiles_json = ?, revision = revision + 1, updated_at = ?, source = ?
			 WHERE scope = 'global' AND revision = ?`,
			[input.raw, input.now, input.source, input.expectedRevision],
		);
		return updated === 1 ? input.expectedRevision + 1 : null;
	}
}
