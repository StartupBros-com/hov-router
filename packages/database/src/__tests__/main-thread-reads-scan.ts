/**
 * Finds every main-thread read in the router's source: each use of
 * `queryMain` or `getMain` (BunSqlAdapter and BaseRepository) outside test
 * files, keyed by file and enclosing named function. main-thread-reads.test.ts
 * compares the result with main-thread-reads.json (#1042).
 *
 * It parses source text with the TypeScript parser and imports no workspace
 * package, so it runs in a fresh worktree before anything is built.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

const METHODS = new Set(["queryMain", "getMain"]);

export interface MainThreadRead {
	/** `<path>#<enclosing named scopes, outermost first>`, or `#<module>`. */
	key: string;
	line: number;
}

function isFunctionLike(node: ts.Node | undefined): boolean {
	return (
		node !== undefined &&
		(ts.isArrowFunction(node) ||
			ts.isFunctionExpression(node) ||
			ts.isClassExpression(node))
	);
}

function nameText(name: ts.Node | undefined): string | undefined {
	if (!name) return undefined;
	if (
		ts.isIdentifier(name) ||
		ts.isPrivateIdentifier(name) ||
		ts.isStringLiteral(name)
	) {
		return name.text;
	}
	return undefined;
}

/** The name a node gives to the code inside it, if it names a scope. */
function scopeName(node: ts.Node): string | undefined {
	if (
		ts.isFunctionDeclaration(node) ||
		ts.isClassDeclaration(node) ||
		ts.isClassExpression(node) ||
		ts.isFunctionExpression(node) ||
		ts.isMethodDeclaration(node) ||
		ts.isGetAccessorDeclaration(node) ||
		ts.isSetAccessorDeclaration(node)
	) {
		return nameText(node.name);
	}
	if (ts.isConstructorDeclaration(node)) return "constructor";
	// A variable or property names its scope when it holds a function. A
	// module-level variable names it whatever it holds, so a read in a
	// top-level `const x = wrap(async () => ...)` is keyed by `x`.
	if (ts.isPropertyDeclaration(node) || ts.isPropertyAssignment(node)) {
		return isFunctionLike(node.initializer) ? nameText(node.name) : undefined;
	}
	if (ts.isVariableDeclaration(node)) {
		const statement = node.parent?.parent;
		const moduleLevel =
			statement !== undefined && ts.isSourceFile(statement.parent);
		return isFunctionLike(node.initializer) || moduleLevel
			? nameText(node.name)
			: undefined;
	}
	return undefined;
}

function enclosingScope(node: ts.Node): string {
	const names: string[] = [];
	for (let at = node.parent; at; at = at.parent) {
		const name = scopeName(at);
		if (name) names.unshift(name);
	}
	return names.length > 0 ? names.join(".") : "<module>";
}

/** Every use of queryMain/getMain in one file: calls, references and `x["queryMain"]`. */
export function findMainThreadReads(
	source: string,
	path: string,
): MainThreadRead[] {
	if (!source.includes("queryMain") && !source.includes("getMain")) return [];
	const file = ts.createSourceFile(
		path,
		source,
		ts.ScriptTarget.Latest,
		true,
		path.endsWith(".tsx") ? ts.ScriptKind.TSX : ts.ScriptKind.TS,
	);
	const reads: MainThreadRead[] = [];
	const visit = (node: ts.Node) => {
		const name = ts.isPropertyAccessExpression(node)
			? node.name.text
			: ts.isElementAccessExpression(node) &&
					ts.isStringLiteralLike(node.argumentExpression)
				? node.argumentExpression.text
				: undefined;
		if (name !== undefined && METHODS.has(name)) {
			const { line } = file.getLineAndCharacterOfPosition(node.getStart(file));
			reads.push({ key: `${path}#${enclosingScope(node)}`, line: line + 1 });
		}
		ts.forEachChild(node, visit);
	};
	visit(file);
	return reads;
}

function isScannedSource(path: string): boolean {
	return !(
		path.includes("/__tests__/") ||
		path.includes("/node_modules/") ||
		path.includes("/dist/") ||
		/\.(test|spec)\.tsx?$/.test(path) ||
		path.endsWith(".d.ts") ||
		// Generated bundles of the worker sources (see AGENTS.md); present only
		// after a build, so scanning them would make the result depend on it.
		/\/inline-[a-z-]*worker\.ts$/.test(path)
	);
}

/** Every main-thread read under apps/*\/src and packages/*\/src, as key -> lines. */
export function scanMainThreadReads(root: string): Map<string, number[]> {
	const found = new Map<string, number[]>();
	const glob = new Bun.Glob("{apps,packages}/*/src/**/*.{ts,tsx}");
	const paths = [...glob.scanSync({ cwd: root })]
		.map((path) => path.split("\\").join("/"))
		.filter(isScannedSource)
		.sort();
	for (const path of paths) {
		const source = readFileSync(join(root, path), "utf8");
		for (const read of findMainThreadReads(source, path)) {
			const lines = found.get(read.key) ?? [];
			lines.push(read.line);
			found.set(read.key, lines);
		}
	}
	return found;
}
