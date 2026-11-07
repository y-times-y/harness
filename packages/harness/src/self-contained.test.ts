import fs from "node:fs";
import { builtinModules } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { expect, it } from "vitest";

const packageDirectory = path.resolve(
	path.dirname(fileURLToPath(import.meta.url)),
	"..",
);
/** The CLI package owns the hand-off wire contract (local-import.ts re-exports it). */
const cliDirectory = path.resolve(packageDirectory, "..", "ytimesy-cli");

function sourceFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory())
			return ["node_modules", "dist"].includes(entry.name)
				? []
				: sourceFiles(file);
		return entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")
			? [file]
			: [];
	});
}

function npmPackageName(specifier: string) {
	const [scopeOrName, name] = specifier.split("/");
	return scopeOrName.startsWith("@") ? `${scopeOrName}/${name}` : scopeOrName;
}

it("imports only from this package, the CLI's wire contract, node builtins and declared dependencies", async () => {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
	);
	const declared = new Set<string>([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
	]);
	const { metafile } = await build({
		absWorkingDir: packageDirectory,
		entryPoints: sourceFiles(path.join(packageDirectory, "src")),
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outdir: "out",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	const inside = (file: string, directory: string) =>
		!path
			.relative(directory, path.resolve(packageDirectory, file))
			.startsWith("..");
	const problems = Object.entries(metafile.inputs).flatMap(([file, input]) => [
		...(inside(file, packageDirectory) ||
		inside(file, path.join(cliDirectory, "src"))
			? []
			: [`${file}: outside the package`]),
		...input.imports
			.filter(
				(item) =>
					item.external &&
					!item.path.startsWith("node:") &&
					!builtinModules.includes(item.path) &&
					!declared.has(npmPackageName(item.path)),
			)
			.map((item) => `${file} imports ${item.path}: not a declared dependency`),
	]);
	expect(problems).toEqual([]);
});
