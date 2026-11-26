/**
 * Every main-thread read is listed (#1042).
 *
 * The router relays every stream on the same thread as the main database
 * connection, so a slow read there pauses all of them. Reads have been moved
 * off that thread one at a time, each after it stalled production (#709, #921,
 * #1019, #1038), and #991 found that this never converges. This test makes a
 * new main-thread read visible in review instead.
 *
 * - `main-thread-reads.json` lists every `queryMain`/`getMain` use by file and
 *   enclosing function, with a count.
 * - A use that is not listed, or a count that rises, fails here. Read off the
 *   thread instead, with `queryOffThread`/`getOffThread` and the lane of
 *   whoever waits. If the read has to stay, list it and say why in the PR.
 * - A count that falls, or an entry that no longer matches, also fails, so a
 *   read moved off the thread cannot quietly come back.
 * - Delete the list and this test when nothing in it is left to move. What
 *   remains then would be reads kept on the main thread on purpose, each with
 *   a reason.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	findMainThreadReads,
	scanMainThreadReads,
} from "./main-thread-reads-scan";

const ROOT = join(import.meta.dir, "../../../..");
const LIST = "packages/database/src/__tests__/main-thread-reads.json";
// The scan reads every source file and parses the ones that mention the two
// methods. That took 2.4 s on an idle host and 6.7 s on a loaded one, past
// bun's 5 s default.
const SCAN_TIMEOUT_MS = 30_000;

describe("main-thread reads (#1042)", () => {
	it(
		"lists every queryMain/getMain use in source, and no entry that is gone",
		() => {
			const listed: Record<string, number> = JSON.parse(
				readFileSync(join(ROOT, LIST), "utf8"),
			).reads;
			const found = scanMainThreadReads(ROOT);
			const problems: string[] = [];
			for (const [key, lines] of found) {
				const allowed = listed[key] ?? 0;
				if (lines.length > allowed) {
					problems.push(
						`${key} has ${lines.length} main-thread read(s) (lines ${lines.join(", ")}), and ${LIST} allows ${allowed}. ` +
							"Read off the main thread with queryOffThread/getOffThread and a lane, " +
							"or list it there and say in the PR why it has to stay.",
					);
				}
			}
			for (const [key, allowed] of Object.entries(listed)) {
				const count = found.get(key)?.length ?? 0;
				if (count < allowed) {
					problems.push(
						`${key} has ${count} main-thread read(s), and ${LIST} says ${allowed}. ` +
							"Lower or delete the entry so the count cannot grow back.",
					);
				}
			}
			expect(problems).toEqual([]);
		},
		SCAN_TIMEOUT_MS,
	);

	it("finds calls, references and string-keyed uses, named by enclosing function", () => {
		const source = [
			"class Repo extends BaseRepository<unknown> {",
			'  async one() { return this.getMain("SELECT 1"); }',
			'  async two() { await this.queryMain("A"); return this.queryMain("B"); }',
			'  async off() { return this.queryOffThread("C", [], "bulk"); }',
			"}",
			'export const handler = async (db: Db) => db.getMain("D");',
			"export function outer(db: Db) {",
			'  const rows = [1].map(async () => db["queryMain"]("E"));',
			"  return rows;",
			"}",
			"const bound = adapter.getMain.bind(adapter);",
			'function other(x: X) { return x.queryMainly() + x.query("F"); }',
		].join("\n");
		const found = findMainThreadReads(source, "f.ts");
		expect(found).toEqual([
			{ key: "f.ts#Repo.one", line: 2 },
			{ key: "f.ts#Repo.two", line: 3 },
			{ key: "f.ts#Repo.two", line: 3 },
			{ key: "f.ts#handler", line: 6 },
			{ key: "f.ts#outer", line: 8 },
			{ key: "f.ts#bound", line: 11 },
		]);
	});
});
