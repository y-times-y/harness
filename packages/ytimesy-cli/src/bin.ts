import { main, processIo } from "./cli.ts";

const [major = 0] = process.versions.node.split(".").map(Number);
if (major < 22) {
	process.stdout.write(
		`Failed: ytimesy needs Node.js 22 or newer (this is ${process.versions.node}).\nNext: Install Node.js 22+, then re-run the same command.\n`,
	);
	process.exit(1);
}

process.exitCode = await main(process.argv.slice(2), processIo());
