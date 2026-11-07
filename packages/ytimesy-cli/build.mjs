// Bundles the CLI and the app's local-session readers into one ESM file.
// esbuild comes from the repository's root node_modules.
import { chmodSync, readFileSync } from "node:fs";
import { build } from "esbuild";

const { version } = JSON.parse(
	readFileSync(new URL("./package.json", import.meta.url), "utf8"),
);
const outfile = new URL("./dist/ytimesy.mjs", import.meta.url).pathname;

await build({
	entryPoints: [new URL("./src/bin.ts", import.meta.url).pathname],
	outfile,
	bundle: true,
	platform: "node",
	format: "esm",
	target: "node22",
	minify: false,
	legalComments: "none",
	banner: { js: "#!/usr/bin/env node" },
	define: { __YTIMESY_VERSION__: JSON.stringify(version) },
	logLevel: "warning",
});
chmodSync(outfile, 0o755);
