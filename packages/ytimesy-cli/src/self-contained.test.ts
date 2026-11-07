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
const SOURCE_FILE = /\.(?:ts|mjs)$/;

function sourceFiles(directory: string): string[] {
	return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const file = path.join(directory, entry.name);
		if (entry.isDirectory())
			return ["node_modules", "dist"].includes(entry.name)
				? []
				: sourceFiles(file);
		return SOURCE_FILE.test(entry.name) ? [file] : [];
	});
}

function npmPackageName(specifier: string) {
	const [scopeOrName, name] = specifier.split("/");
	return scopeOrName.startsWith("@") ? `${scopeOrName}/${name}` : scopeOrName;
}

function declaredDependencies() {
	const manifest = JSON.parse(
		fs.readFileSync(path.join(packageDirectory, "package.json"), "utf8"),
	);
	return new Set<string>([
		...Object.keys(manifest.dependencies ?? {}),
		...Object.keys(manifest.devDependencies ?? {}),
	]);
}

it("imports only from its own folder, node builtins and declared dependencies", async () => {
	const declared = declaredDependencies();
	const { metafile } = await build({
		absWorkingDir: packageDirectory,
		entryPoints: sourceFiles(packageDirectory),
		bundle: true,
		packages: "external",
		platform: "node",
		format: "esm",
		outdir: "out",
		write: false,
		metafile: true,
		logLevel: "silent",
	});
	const problems = Object.entries(metafile.inputs).flatMap(([file, input]) => [
		...(path
			.relative(packageDirectory, path.resolve(packageDirectory, file))
			.startsWith("..")
			? [`${file}: outside the package`]
			: []),
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
