import { spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { START_TICK } from "./api-command-scope";

/**
 * The runner identifies a command's process by its start time. On macOS there
 * is no /proc, so START_TICK reads `ps -o lstart= -p PID`. These tests give it
 * a stand-in `ps` that prints what macOS prints (English under LC_ALL=C, French
 * otherwise) so the parsing and locale handling run on any machine.
 */

/** `ps -o lstart=` output as macOS prints it: day of month padded with a space. */
const MACOS_ENGLISH: Record<string, string> = {
	"100": "Fri Nov  6 10:09:11 2026",
	"101": "Sat Nov 14 23:59:59 2026",
	"102": "Sun Mar  8 03:00:00 2026",
};
/** The same instants as a French macOS prints them without LC_ALL=C. */
const MACOS_FRENCH: Record<string, string> = {
	"100": "ven.  6 nov 10:09:11 2026",
	"101": "sam. 14 nov 23:59:59 2026",
	"102": "dim.  8 mars 03:00:00 2026",
};

function fakeBin(script: string) {
	const directory = mkdtempSync(join(tmpdir(), "k-fake-ps-"));
	const file = join(directory, "ps");
	writeFileSync(file, script);
	chmodSync(file, 0o755);
	return directory;
}

const FAKE_PS = `#!/bin/sh
# usage: ps -o lstart= -p PID
[ "$1 $2 $3" = "-o lstart= -p" ] || { echo "unexpected args: $*" >&2; exit 2; }
pid=$4
if [ "$LC_ALL" = "C" ]; then
  case $pid in
${Object.entries(MACOS_ENGLISH)
	.map(([pid, text]) => `    ${pid}) echo "${text}";;`)
	.join("\n")}
    *) exit 1;;
  esac
else
  case $pid in
${Object.entries(MACOS_FRENCH)
	.map(([pid, text]) => `    ${pid}) echo "${text}";;`)
	.join("\n")}
    *) exit 1;;
  esac
fi
`;

const PYTHON = spawnSync("which", ["python3"], {
	encoding: "utf8",
}).stdout.trim();

function startTick(
	pid: number,
	options: { bin?: string; env?: Record<string, string> } = {},
) {
	const program = `import os, pathlib, subprocess, sys\n${START_TICK.replaceAll("/proc/", "/no-such-proc/")}\nprint(start_tick(int(sys.argv[1])))`;
	return spawnSync(PYTHON, ["-c", program, String(pid)], {
		encoding: "utf8",
		env: {
			PATH: `${options.bin ?? fakeBin(FAKE_PS)}:/usr/bin:/bin`,
			...options.env,
		},
	});
}

it("takes the start time from ps exactly as macOS prints it, including a padded day", () => {
	for (const [pid, text] of Object.entries(MACOS_ENGLISH)) {
		const result = startTick(Number(pid));
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(text);
	}
});

it("gets the same text twice, so a live process is recognised later", () => {
	const bin = fakeBin(FAKE_PS);
	expect(startTick(100, { bin }).stdout).toBe(startTick(100, { bin }).stdout);
});

it("asks ps for the C locale whatever language or time zone the user has", () => {
	for (const locale of ["fr_FR.UTF-8", "ja_JP.UTF-8", "de_DE.UTF-8"]) {
		const result = startTick(100, {
			env: {
				LC_ALL: locale,
				LANG: locale,
				LC_TIME: locale,
				TZ: "Asia/Kolkata",
			},
		});
		expect(result.status, result.stderr).toBe(0);
		expect(result.stdout.trim()).toBe(MACOS_ENGLISH["100"]);
		expect(result.stdout).not.toContain("ven.");
	}
});

it("treats a process ps does not know as gone, not as a crash", () => {
	const result = startTick(4242);
	expect(result.status).not.toBe(0);
	expect(result.stderr).toContain("ProcessLookupError");
});

it("still starts the command where ps is missing or not allowed to run", () => {
	const empty = mkdtempSync(join(tmpdir(), "k-no-ps-"));
	const missing = spawnSync(
		PYTHON,
		[
			"-c",
			`import os, pathlib, subprocess, sys\n${START_TICK.replaceAll("/proc/", "/no-such-proc/")}\nprint(start_tick(1))`,
		],
		{ encoding: "utf8", env: { PATH: empty } },
	);
	expect(missing.status, missing.stderr).toBe(0);
	expect(missing.stdout.trim()).toBe("unknown");

	const notExecutable = mkdtempSync(join(tmpdir(), "k-denied-ps-"));
	writeFileSync(join(notExecutable, "ps"), "#!/bin/sh\n");
	chmodSync(join(notExecutable, "ps"), 0o644);
	const denied = startTick(1, { env: { PATH: notExecutable } });
	expect(denied.status, denied.stderr).toBe(0);
	expect(denied.stdout.trim()).toBe("unknown");
});
