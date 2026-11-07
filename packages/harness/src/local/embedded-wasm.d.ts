/** build.mjs bundles this file's bytes into the single-file command (esbuild loader "binary"). */
declare module "@jitl/quickjs-wasmfile-release-sync/wasm" {
	const bytes: Uint8Array;
	export default bytes;
}
