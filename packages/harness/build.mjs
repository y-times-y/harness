// Bundles the local runner into one ESM file and writes the license texts of
// the npm packages inside it. esbuild comes from the repository's root
// node_modules.
import {
	chmodSync,
	existsSync,
	readdirSync,
	readFileSync,
	realpathSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const here = dirname(fileURLToPath(import.meta.url));
const outfile = resolve(here, "dist/ytimesy-harness.mjs");

const { metafile } = await build({
	absWorkingDir: here,
	entryPoints: [resolve(here, "src/local/bin.ts")],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	// The QuickJS engine behind run_code is a .wasm file; embed its bytes.
	loader: { ".wasm": "binary" },
	// Keep the dependencies' own license headers; the full texts go to
	// THIRD_PARTY_LICENSES.txt below.
	legalComments: "eof",
	metafile: true,
	banner: {
		js: '#!/usr/bin/env node\nimport { createRequire as __createRequire } from "node:module";\nconst require = __createRequire(import.meta.url);',
	},
	logLevel: "warning",
});
chmodSync(outfile, 0o755);

// The npm packages whose code is in the bundle.
const packageDirectories = new Set();
for (const output of Object.values(metafile.outputs))
	for (const input of Object.keys(output.inputs)) {
		const file = resolve(here, input);
		if (!existsSync(file)) continue;
		const match = realpathSync(file).match(
			/^(.*\/node_modules\/(?:@[^/]+\/)?[^/]+)\//,
		);
		if (match) packageDirectories.add(match[1]);
	}

const sections = [...packageDirectories]
	.map((directory) => {
		const manifest = JSON.parse(
			readFileSync(`${directory}/package.json`, "utf8"),
		);
		const licenseFiles = readdirSync(directory).filter((name) =>
			/^(licen[cs]e|notice|copying|thirdpartynotice)/i.test(name),
		);
		const texts = licenseFiles.length
			? licenseFiles
					.map((name) => readFileSync(`${directory}/${name}`, "utf8").trim())
					.join("\n\n")
			: `(${manifest.name} ships no license file; its package.json declares ${manifest.license}. See ${manifest.repository?.url ?? "its npm page"}.)`;
		return {
			key: `${manifest.name}@${manifest.version}`,
			body: `${manifest.name}@${manifest.version} (${manifest.license})\n${"-".repeat(72)}\n${texts}`,
		};
	})
	.sort((a, b) => (a.key < b.key ? -1 : 1));
writeFileSync(
	resolve(here, "dist/THIRD_PARTY_LICENSES.txt"),
	`The ytimesy-harness command bundles the following open-source packages.\nTheir licenses and notices follow.\n\n${sections.map((section) => section.body).join("\n\n\n")}\n`,
);
