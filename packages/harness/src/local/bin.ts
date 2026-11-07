import quickjsWasm from "@jitl/quickjs-wasmfile-release-sync/wasm";
import { provideCodeModeWasmModule } from "../server/services/code-mode-sandbox";
import { main } from "./cli";

// run_code's JavaScript engine is a WebAssembly file that a bundle cannot
// find next to itself; build.mjs embeds its bytes in this file instead.
provideCodeModeWasmModule(() =>
	WebAssembly.compile(new Uint8Array(quickjsWasm)),
);

const [major = 0] = process.versions.node.split(".").map(Number);
if (major < 22) {
	process.stderr.write(
		`Failed: ytimesy-harness needs Node.js 22 or newer (this is ${process.versions.node}).\nNext: Install Node.js 22+, then run again.\n`,
	);
	process.exit(1);
}

const controller = new AbortController();
process.once("SIGINT", () => controller.abort());
process.exitCode = await main(process.argv.slice(2), {
	env: process.env,
	cwd: process.cwd(),
	stdout: (text) => process.stdout.write(text),
	stderr: (text) => process.stderr.write(text),
	signal: controller.signal,
});
