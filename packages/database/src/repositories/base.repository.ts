import type {
	BunSqlAdapter,
	OffThreadReadLane,
} from "../adapters/bun-sql-adapter";

export abstract class BaseRepository<_T> {
	constructor(protected adapter: BunSqlAdapter) {}

	protected queryOffThread<R>(
		sql: string,
		params: unknown[],
		lane: OffThreadReadLane,
	): Promise<R[]> {
		return this.adapter.queryOffThread<R>(sql, params, lane);
	}

	protected getOffThread<R>(
		sql: string,
		params: unknown[],
		lane: OffThreadReadLane,
	): Promise<R | null> {
		return this.adapter.getOffThread<R>(sql, params, lane);
	}

	/** Reads on the main thread; see BunSqlAdapter.queryMain before adding one. */
	protected async queryMain<R>(
		sql: string,
		params: unknown[] = [],
	): Promise<R[]> {
		return this.adapter.queryMain<R>(sql, params);
	}

	/** Reads on the main thread; see BunSqlAdapter.queryMain before adding one. */
	protected async getMain<R>(
		sql: string,
		params: unknown[] = [],
	): Promise<R | null> {
		return this.adapter.getMain<R>(sql, params);
	}

	protected async run(sql: string, params: unknown[] = []): Promise<void> {
		return this.adapter.run(sql, params);
	}

	protected async runWithChanges(
		sql: string,
		params: unknown[] = [],
	): Promise<number> {
		return this.adapter.runWithChanges(sql, params);
	}

	protected async runReturningOne<R>(
		sql: string,
		params: unknown[] = [],
	): Promise<R | null> {
		return this.adapter.runReturningOne<R>(sql, params);
	}
}
