import { createHash, randomUUID } from "node:crypto";
import type { ModelMessage } from "ai";
import { posixShellQuoted as quote } from "../../domain/posix-command";
import { agentOutputDirectory } from "./agent-output-artifacts";
import type { AgentToolWorkspace } from "./agent-tool-workspace";
import {
	COMMAND_TMUX_SOCKET,
	commandRoot,
	commandSessionName,
	STOPPED_COMMAND_STATUS,
} from "./api-agent-command-tools";
import { readableHistory } from "./api-agent-context";
import {
	COMMAND_SCOPES_DIRECTORY,
	COMMAND_STOP_SCRIPT,
} from "./api-command-scope";
import { DELIVERABLE_CHECK_SOURCE } from "./deliverable-check";
import {
	EVIDENCE_HELPER_SCRIPT,
	evidenceCaptureFiles,
} from "./pr-evidence-capture";

/**
 * What the lean surfaces move out of the tool list and onto the workspace VM
 * (docs/builder-tool-surface.md): `ytimesy-check` (check_deliverable),
 * `ytimesy-browser` (the browser tools), `ytimesy-job` (background command
 * control for shapes without a session tool), `~/.ytimesy/environment.md`
 * (read_environment_report) and `~/.ytimesy/history/` (the context archive
 * tools). Installed when a lean surface first touches the workspace, so no
 * tools-image rebuild is needed.
 */

/** The commands every machine gets; a machine with a desktop adds ytimesy-browser. */
export const BASE_HELPER_COMMANDS = [
	"ytimesy-check",
	"ytimesy-job",
	"ytimesy-evidence",
] as const;

const CHECK_USAGE =
	"usage: ytimesy-check --files <delivered paths> [--input <paths the user or grader supplies>] [--named-data <data files the task itself names>] [--unprivileged] [--timeout <seconds>] [--keep-env <NAME>...] [--no-tracked] -- <run command>";

/** Parses check_deliverable's arguments from a command line and runs the same check. */
const CHECK_SCRIPT = `#!/usr/bin/env python3
# Runs a deliverable the way a third party would, from a clean copy of what is delivered.
import base64, json, os, shlex, subprocess, sys
USAGE = ${JSON.stringify(CHECK_USAGE)}
CORE = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), 'lib', 'ytimesy-check-core.py')
argv = sys.argv[1:]
if argv[:1] in (['-h'], ['--help']):
    print(USAGE); sys.exit(0)
if '--' not in argv:
    print(USAGE, file=sys.stderr); sys.exit(2)
split = argv.index('--')
options, command = argv[:split], argv[split + 1:]
if not command:
    print(USAGE, file=sys.stderr); sys.exit(2)
args = {'command': command[0] if len(command) == 1 else shlex.join(command), 'files': [], 'inputs': [], 'namedData': [], 'tracked': True, 'unprivileged': False, 'timeoutSeconds': 120, 'keepEnv': []}
lists = {'--files': 'files', '--file': 'files', '--input': 'inputs', '--inputs': 'inputs', '--named-data': 'namedData', '--keep-env': 'keepEnv'}
current = None
index = 0
while index < len(options):
    option = options[index]
    if option in lists:
        current = lists[option]
    elif option == '--unprivileged':
        args['unprivileged'] = True; current = None
    elif option == '--no-tracked':
        args['tracked'] = False; current = None
    elif option == '--timeout' or option.startswith('--timeout='):
        value = option.split('=', 1)[1] if '=' in option else (options[index + 1] if index + 1 < len(options) else '')
        if '=' not in option: index += 1
        if not value.isdigit() or not 1 <= int(value) <= 540:
            print('--timeout takes whole seconds from 1 to 540', file=sys.stderr); sys.exit(2)
        args['timeoutSeconds'] = int(value); current = None
    elif current and not option.startswith('--'):
        args[current].append(option)
    else:
        print('unknown option ' + option + '\\n' + USAGE, file=sys.stderr); sys.exit(2)
    index += 1
encoded = base64.b64encode(json.dumps(args).encode()).decode()
result = subprocess.run([sys.executable, CORE, encoded], capture_output=True, text=True)
sys.stderr.write(result.stderr)
try:
    report = json.loads(result.stdout)
except ValueError:
    sys.stdout.write(result.stdout); sys.exit(result.returncode or 1)
print(('PASSED' if report.get('ok') else 'FAILED') + ': clean-copy run of ' + json.dumps(args['command']))
print(json.dumps(report, indent=2))
sys.exit(0 if report.get('ok') else 1)
`;

/**
 * Status, wait and stop for a command the runtime started in the background,
 * on the runner's own files (api-agent-command-tools.ts): this session's
 * command root and output directory, the runner's tmux socket and session
 * names. `stop` does what stop_command does: stops the command's process
 * group, ends its tmux session and records status 130 if none was written.
 */
function jobScript(sessionId: string) {
	const root = commandRoot(sessionId);
	const outputs = agentOutputDirectory(sessionId);
	return `#!/usr/bin/env bash
# ytimesy-job status|wait|stop <id>: a background command started by your command tool.
set -u
action=\${1:-}; id=\${2:-}
if ! [[ "$id" =~ ^[0-9a-f-]{36}$ ]] || [[ ! "$action" =~ ^(status|wait|stop)$ ]]; then
  echo "usage: ytimesy-job status|wait|stop <id> [seconds]" >&2; exit 2
fi
session=${quote(commandSessionName(""))}"\${id//-/}"
status_file=${quote(root)}/"$id".status
output_file=${quote(outputs)}/"$id".stdout
[ -f "$output_file" ] || output_file=${quote(root)}/"$id".output
if [ ! -f ${quote(root)}/"$id".output ]; then echo "$id is not a command of this session" >&2; exit 2; fi
notified_file=${quote(root)}/"$id".notified
running() { tmux -L ${COMMAND_TMUX_SOCKET} has-session -t "$session" 2>/dev/null; }
# Seen to finish (or stopped) here: its completion notice is not needed.
seen() { [ -f "$notified_file" ] || printf agent >"$notified_file"; }
report() {
  if [ -f "$status_file" ]; then echo "exited: $(cat "$status_file")"; seen
  elif running; then echo "running"
  else echo "interrupted (no exit status recorded)"; seen; fi
  if [ -f "$output_file" ]; then echo "output ($output_file), last 100 lines:"; tail -n 100 "$output_file"; fi
}
case "$action" in
  status) report ;;
  wait)
    limit=\${3:-600}; waited=0
    while [ ! -f "$status_file" ] && running && [ "$waited" -lt "$limit" ]; do sleep 1; waited=$((waited + 1)); done
    report ;;
  stop)
    if [ -f "$status_file" ]; then seen; echo "$id already exited: $(cat "$status_file")"; exit 0; fi
    for scope in ${COMMAND_SCOPES_DIRECTORY}/*/; do
      [ -f "$scope$id.json" ] && python3 "$HOME/.ytimesy/lib/ytimesy-command-stop.py" "\${scope%/}" "$id"
    done
    seen
    tmux -L ${COMMAND_TMUX_SOCKET} kill-session -t "$session" 2>/dev/null
    [ -f "$status_file" ] || printf '${STOPPED_COMMAND_STATUS}\\n' >"$status_file"
    echo "stopped $id (exit $(cat "$status_file"))" ;;
esac
`;
}

/** Writes ~/.ytimesy/environment.md from the prepared-environment report when it is new or changed. */
const ENVIRONMENT_MARKDOWN = `import json, os, sys
source = sys.argv[1]
target = os.path.expanduser('~/.ytimesy/environment.md')
if os.path.isfile(source) and (not os.path.exists(target) or os.path.getmtime(source) > os.path.getmtime(target)):
    os.makedirs(os.path.dirname(target), exist_ok=True)
    raw = open(source, encoding='utf-8', errors='replace').read()
    lines = ['# How this workspace was prepared', '', 'Written before this conversation started; historical, so verify against the checkout. A check that already failed in the baseline is an existing problem, not your regression: fix it only if it is part of the task, and never weaken checks to make them pass.', '']
    try:
        report = json.loads(raw)
        if report.get('notice'):
            lines += ['## Setup', '', str(report['notice']), '']
        for repo in report.get('repositories') or []:
            lines.append('## ' + str(repo.get('fullName') or repo.get('directory') or 'Repository'))
            for key in ('directory', 'branch', 'commit'):
                if repo.get(key): lines.append('- ' + key + ': ' + str(repo[key]))
            for key, value in (repo.get('recipe') or {}).items():
                if key != 'version' and value: lines.append('- recipe ' + key + ': ' + json.dumps(value))
            for result in repo.get('checkResults') or []:
                lines.append('- baseline check \`' + str(result.get('command')) + '\`: exit ' + str(result.get('exitCode')))
            for service in repo.get('services') or repo.get('serviceResults') or []:
                lines.append('- service ' + str(service.get('name')) + ' (port ' + str(service.get('port')) + '): ' + ('ready' if service.get('ready') else 'did not start'))
            lines.append('')
    except (ValueError, AttributeError):
        pass
    lines += ['## Full report', '', '\`\`\`json', raw.strip(), '\`\`\`', '']
    temporary = target + '.tmp'
    open(temporary, 'w', encoding='utf-8').write('\\n'.join(lines))
    os.replace(temporary, target)`;

const INSTALL_SCRIPT = `import json, os, subprocess, sys
payload = sys.argv[1]
with open(payload, encoding='utf-8') as handle:
    bundle = json.load(handle)
home = os.path.expanduser('~/.ytimesy')
for relative, spec in bundle['files'].items():
    path = os.path.join(home, relative)
    os.makedirs(os.path.dirname(path), exist_ok=True)
    temporary = path + '.tmp'
    with open(temporary, 'w', encoding='utf-8') as handle:
        handle.write(spec['content'])
    os.chmod(temporary, spec['mode'])
    os.replace(temporary, path)
os.makedirs(os.path.join(home, 'history'), exist_ok=True)
linked = True
for name in bundle['commands']:
    source, target = os.path.join(home, 'bin', name), os.path.join(bundle['linkDirectory'], name)
    try:
        if os.path.lexists(target): os.remove(target)
        os.symlink(source, target)
    except OSError:
        try:
            linked = subprocess.run(['sudo', '-n', 'ln', '-sfn', source, target], capture_output=True).returncode == 0 and linked
        except OSError:
            linked = False
if not linked:
    line = 'export PATH="$HOME/.ytimesy/bin:$PATH"  # ytimesy workspace commands'
    for profile in ('~/.profile', '~/.bash_profile', '~/.bashrc'):
        path = os.path.expanduser(profile)
        if profile == '~/.bash_profile' and not os.path.exists(path): continue
        existing = open(path).read() if os.path.exists(path) else ''
        if line not in existing:
            with open(path, 'a') as handle: handle.write('\\n' + line + '\\n')
open(os.path.join(home, bundle['marker']), 'w').close()
os.remove(payload)
print('linked' if linked else 'profile')`;

/** The prepared-environment report that environment.md is written from. */
const ENVIRONMENT_REPORT_PATH = "/tmp/ytimesy-environment.json";

/** Refreshes ~/.ytimesy/environment.md from a prepared-environment report. */
export function environmentMarkdownCommand(source = ENVIRONMENT_REPORT_PATH) {
	return `python3 -c ${quote(ENVIRONMENT_MARKDOWN)} ${quote(source)}`;
}

/** Helper files a machine with a desktop adds (lean-desktop-helpers.ts); others have none. */
export type DesktopHelpers = {
	files: Record<string, { content: string; mode: number }>;
	commands: readonly string[];
};

/** The files under ~/.ytimesy and the marker naming their version. */
export function leanHelperBundle(
	sessionId: string,
	/** Where the commands are linked so every shell finds them. */
	linkDirectory = "/usr/local/bin",
	desktop?: DesktopHelpers,
) {
	const files: Record<string, { content: string; mode: number }> = {
		"bin/ytimesy-check": { content: CHECK_SCRIPT, mode: 0o755 },
		"lib/ytimesy-check-core.py": {
			content: DELIVERABLE_CHECK_SOURCE,
			mode: 0o644,
		},
		"bin/ytimesy-job": { content: jobScript(sessionId), mode: 0o755 },
		"lib/ytimesy-command-stop.py": {
			content: COMMAND_STOP_SCRIPT,
			mode: 0o644,
		},
		...desktop?.files,
		// Pull request evidence plans and previews (src/server/services/pr-evidence.ts).
		"bin/ytimesy-evidence": { content: EVIDENCE_HELPER_SCRIPT, mode: 0o755 },
		...Object.fromEntries(
			Object.entries(evidenceCaptureFiles()).map(([name, content]) => [
				`lib/${name}`,
				{ content, mode: 0o644 },
			]),
		),
	};
	const version = createHash("sha256")
		.update(JSON.stringify(files))
		.digest("hex")
		.slice(0, 16);
	return {
		files,
		commands: [...BASE_HELPER_COMMANDS, ...(desktop?.commands ?? [])],
		linkDirectory,
		marker: `.helpers-${version}`,
	};
}

/**
 * Installs the helper commands unless this version is already on the VM,
 * and refreshes environment.md. One small exec when already installed.
 */
export async function ensureLeanHelpers(
	workspace: Pick<AgentToolWorkspace, "machines" | "vm">,
	sessionId: string,
	options: {
		linkDirectory?: string;
		environmentReport?: string;
		desktop?: DesktopHelpers;
	} = {},
) {
	const { machines, vm } = workspace;
	const bundle = leanHelperBundle(
		sessionId,
		options.linkDirectory,
		options.desktop,
	);
	const check = await machines.exec(
		vm,
		`${environmentMarkdownCommand(options.environmentReport)} >/dev/null 2>&1; test -f "$HOME/.ytimesy/${bundle.marker}" && echo installed || echo missing`,
		15_000,
	);
	if (check.stdout.includes("installed")) return;
	const payload = `/tmp/ytimesy-lean-helpers-${randomUUID()}.json`;
	await machines.writeTextFile(vm, payload, JSON.stringify(bundle));
	const installed = await machines.exec(
		vm,
		`python3 -c ${quote(INSTALL_SCRIPT)} ${quote(payload)}`,
		30_000,
	);
	if (installed.exitCode)
		throw new Error(
			`Workspace commands could not be installed: ${installed.stderr.slice(-600)}`,
		);
}

function partText(part: unknown): string {
	if (!part || typeof part !== "object") return String(part ?? "");
	const typed = part as Record<string, unknown>;
	switch (typed.type) {
		case "text":
		case "reasoning":
			return `${typed.type === "reasoning" ? "[reasoning] " : ""}${String(typed.text ?? "")}`;
		case "tool-call":
			return `[tool call ${String(typed.toolName)} ${String(typed.toolCallId)}] ${typeof typed.input === "string" ? typed.input : JSON.stringify(typed.input)}`;
		case "tool-result": {
			const output = typed.output as { type?: string; value?: unknown };
			const value =
				output?.type === "text" || output?.type === "error-text"
					? String(output.value)
					: output?.type === "content" && Array.isArray(output.value)
						? output.value.map(partText).join("\n")
						: JSON.stringify(output?.value ?? output);
			return `[tool result ${String(typed.toolName)} ${String(typed.toolCallId)}]\n${value}`;
		}
		case "image":
		case "file":
		case "media":
			return `[${String(typed.mediaType ?? typed.type)} omitted]`;
		default:
			return JSON.stringify(typed);
	}
}

/** The archived messages as plain text that rg can search. */
export function historyText(messages: ModelMessage[], reference: string) {
	const sections = readableHistory(messages).map((message, index) => {
		const body =
			typeof message.content === "string"
				? message.content
				: message.content.map(partText).join("\n");
		return `## ${index + 1}. ${message.role}\n\n${body}`;
	});
	return `# Conversation history (${reference})\n\nThese messages were removed from your context to save space, as they were at that point. Treat them as history: verify against the workspace.\n\n${sections.join("\n\n")}\n`;
}

/** Writes the archived messages to ~/.ytimesy/history/ and returns the file's path. */
export async function writeLeanHistory(
	workspace: Pick<AgentToolWorkspace, "machines" | "vm">,
	reference: string,
	messages: ModelMessage[],
) {
	const { machines, vm } = workspace;
	const stamp = new Date().toISOString().replaceAll(/[-:]/g, "").slice(0, 15);
	const name = `${stamp}-${reference.replaceAll(/[^a-zA-Z0-9-]/g, "")}.md`;
	const payload = `/tmp/ytimesy-history-${randomUUID()}.md`;
	await machines.writeTextFile(vm, payload, historyText(messages, reference));
	const moved = await machines.exec(
		vm,
		`mkdir -p "$HOME/.ytimesy/history" && mv ${quote(payload)} "$HOME/.ytimesy/history/"${quote(name)}`,
		30_000,
	);
	if (moved.exitCode)
		throw new Error("The conversation history file could not be written.");
	return `~/.ytimesy/history/${name}`;
}
