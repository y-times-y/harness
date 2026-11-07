import { createHash, randomUUID } from "node:crypto";
import { tool } from "ai";
import { z } from "zod";
import { projectSourceEvidence } from "../../domain/project-source-evidence";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
/**
 * The longest shell command a tool accepts. A started job travels to the
 * machine as one base64 argument, and Linux caps a single argument at 128 KiB,
 * so 48,000 characters (64 KB encoded) leaves room. Generated check scripts
 * passed inline reach 17-19k characters; a lower cap rejected them and made
 * the model resend shorter copies.
 */
export const COMMAND_MAX_CHARACTERS = 48_000;
export const verificationReceiptSchema = z.object({
	command: z.string().min(1).max(COMMAND_MAX_CHARACTERS),
	cwd: z.string().min(1).max(4096),
	before: projectSourceEvidence,
	after: projectSourceEvidence,
	sourcesStable: z.boolean(),
});
export const agentOutputPageSchema = z.object({
	reference: z.uuid(),
	stream: z.enum(["stdout", "stderr"]).default("stdout"),
	start: z.number().int().min(0).max(32_000_000).default(0),
	view: z.enum(["page", "summary"]).optional(),
});
const PAGE_SCRIPT = `import hashlib, json, os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1])
if root.is_symlink():
    raise ValueError('Artifact root cannot be a symlink')
reference, stream, start = sys.argv[2], sys.argv[3], int(sys.argv[4])
view = sys.argv[5]
if view == 'summary' and start != 0:
    raise ValueError('Summary reads cannot have a page offset')
descriptor = os.open(root / (reference + '.' + stream), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
with os.fdopen(descriptor, 'r', encoding='utf-8', errors='replace') as handle:
    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
        raise ValueError('Artifact must be a regular file')
    if view == 'summary':
        digest, characters, tail = hashlib.sha256(), 0, ''
        for chunk in iter(lambda: handle.read(65536), ''):
            digest.update(chunk.encode('utf-8'))
            characters += len(chunk)
            tail = (tail + chunk)[-2000:]
        page = {'reference': reference, 'stream': stream, 'view': 'summary', 'content': tail, 'characters': characters, 'omittedCharacters': characters - len(tail), 'contentSha256': digest.hexdigest(), 'fullOutput': {'reference': reference, 'stream': stream, 'start': 0, 'view': 'page'}}
    else:
        handle.read(start)
        content = handle.read(32001)
        page = {'reference': reference, 'stream': stream, 'start': start, 'content': content[:32000], 'nextStart': start + 32000 if len(content) > 32000 else None}
try:
    descriptor = os.open(root / (reference + '.receipt.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    pass  # Older or still-running captures have no persisted completion receipt.
else:
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Completion receipt must be a regular file')
        receipt = json.loads(handle.read(513))
    if type(receipt.get('exitCode')) is not int or receipt.get('stopped') not in (None, 'timeout', 'output_limit'):
        raise ValueError('Invalid completion receipt')
    page['completion'] = {'status': receipt['exitCode'], 'stopped': receipt['stopped']}
try:
    descriptor = os.open(root / (reference + '.verification.json'), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    pass
else:
    with os.fdopen(descriptor, encoding='utf-8') as handle:
        if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
            raise ValueError('Verification receipt must be a regular file')
        page['verification'] = json.loads(handle.read(65537))
print(json.dumps(page, ensure_ascii=False))`;

// Reuse the exact page reader, including its confinement and receipt checks.
const BUNDLE_SCRIPT = `import contextlib, io, json, sys
directory, references, reader = sys.argv[1], json.loads(sys.argv[2]), sys.argv[3]
pages = []
for reference in references:
    streams = {}
    for stream in ('stdout', 'stderr'):
        sys.argv = ['reader', directory, reference, stream, '0', 'summary']
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            exec(reader, {})
        streams[stream] = json.loads(output.getvalue())
    pages.append(streams)
print(json.dumps(pages, ensure_ascii=False))`;

const RECORD_VERIFICATION_SCRIPT = `import json, os, pathlib, sys
root = pathlib.Path(sys.argv[1])
if root.is_symlink():
    raise ValueError('Artifact root cannot be a symlink')
descriptor = os.open(root / (sys.argv[2] + '.verification.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
    json.dump(json.loads(sys.argv[3]), handle)`;

/** A captured command is stopped once its stdout or stderr passes this ("output_limit"). */
export const AGENT_OUTPUT_LIMIT_BYTES = 16 * 1024 * 1024;

const CAPTURE_SCRIPT = `import json, os, pathlib, signal, subprocess, sys, time
root = pathlib.Path(sys.argv[1])
root.mkdir(mode=0o700, exist_ok=True)
if root.is_symlink():
    raise ValueError('Artifact root cannot be a symlink')
reference, command, timeout = sys.argv[2], sys.argv[3], int(sys.argv[4])
merge = len(sys.argv) > 5 and sys.argv[5] == '1'
handles = []
try:
    for stream in ('stdout', 'stderr'):
        descriptor = os.open(root / (reference + '.' + stream), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        handles.append(os.fdopen(descriptor, 'wb'))
    process = subprocess.Popen(command, shell=True, stdout=handles[0], stderr=handles[0] if merge else handles[1], start_new_session=True)
    deadline = time.monotonic() + timeout
    stopped = None
    try:
        while process.poll() is None:
            if time.monotonic() >= deadline:
                stopped = 'timeout'
                break
            if any(os.fstat(handle.fileno()).st_size > ${AGENT_OUTPUT_LIMIT_BYTES} for handle in handles):
                stopped = 'output_limit'
                break
            time.sleep(0.05)
    finally:
        if process.poll() is None:
            try:
                os.killpg(process.pid, signal.SIGTERM)
            except ProcessLookupError:
                pass
            grace = time.monotonic() + 2.5
            while time.monotonic() < grace:
                process.poll()
                try:
                    os.killpg(process.pid, 0)
                except ProcessLookupError:
                    break
                time.sleep(0.05)
            try:
                os.killpg(process.pid, signal.SIGKILL)
            except ProcessLookupError:
                pass
        process.wait()
    for handle in handles:
        handle.close()
    output = {'reference': reference, 'exitCode': process.returncode, 'stopped': stopped}
    for stream in ('stdout', 'stderr'):
        path = root / (reference + '.' + stream)
        if path.stat().st_size > ${AGENT_OUTPUT_LIMIT_BYTES}:
            stopped = 'output_limit'
            with path.open('r+b') as handle:
                handle.truncate(${AGENT_OUTPUT_LIMIT_BYTES})
        with path.open(encoding='utf-8', errors='replace') as handle:
            content = handle.read(32001)
        output[stream] = content[:32000]
        output[stream + 'NextStart'] = 32000 if len(content) > 32000 else None
    output['stopped'] = stopped
    if stopped:
        output['exitCode'] = 124 if stopped == 'timeout' else 125
    descriptor = os.open(root / (reference + '.receipt.json'), os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        json.dump({'exitCode': output['exitCode'], 'stopped': output['stopped']}, handle)
    print(json.dumps(output, ensure_ascii=False))
finally:
    for handle in handles:
        handle.close()`;

export type AgentOutput = {
	reference: string;
	exitCode: number;
	stopped: "timeout" | "output_limit" | null;
	stdout: string;
	stderr: string;
	stdoutNextStart: number | null;
	stderrNextStart: number | null;
};

/** The guest directory holding a session's complete command output (`<reference>.stdout`). */
export function agentOutputDirectory(sessionId: string) {
	return `/tmp/ytimesy-output-${createHash("sha256").update(sessionId).digest("hex")}`;
}

/** Guest-local, session-scoped evidence; never accepts an arbitrary host path. */
export function agentOutputArtifacts(
	input: AgentToolWorkspaceInput & { sessionId: string; signal: AbortSignal },
) {
	const directory = agentOutputDirectory(input.sessionId);
	const captureCommand = (
		command: string,
		timeoutSeconds: number,
		reference: string,
		mergeOutput = false,
	) =>
		`python3 -c ${quote(CAPTURE_SCRIPT)} ${quote(directory)} ${quote(reference)} ${quote(command)} ${timeoutSeconds} ${mergeOutput ? 1 : 0}`;
	const read = async (page: z.input<typeof agentOutputPageSchema>) => {
		input.signal.throwIfAborted();
		const parsed = agentOutputPageSchema.parse(page);
		const { machines, vm } = await resolveToolWorkspace(input);
		const result = await machines.exec(
			vm,
			`python3 -c ${quote(PAGE_SCRIPT)} ${quote(directory)} ${quote(parsed.reference)} ${parsed.stream} ${parsed.start} ${parsed.view ?? "page"}`,
			15_000,
		);
		if (result.exitCode)
			throw new Error("Output reference is unavailable in this session.");
		const pageResult = JSON.parse(result.stdout);
		if (pageResult.verification)
			pageResult.verification = verificationReceiptSchema.parse(
				pageResult.verification,
			);
		return pageResult as {
			reference: string;
			stream: string;
			start?: number;
			content: string;
			nextStart?: number | null;
			view?: "summary";
			characters?: number;
			omittedCharacters?: number;
			contentSha256?: string;
			fullOutput?: z.input<typeof agentOutputPageSchema>;
			verification?: z.infer<typeof verificationReceiptSchema>;
			completion?: {
				status: number;
				stopped: "timeout" | "output_limit" | null;
			};
		};
	};
	return {
		directory,
		captureCommand,
		read,
		async readBundle(references: readonly string[]) {
			input.signal.throwIfAborted();
			const ids = z.array(z.uuid()).min(1).max(8).parse(references);
			if (new Set(ids).size !== ids.length)
				throw new Error("Check references must be distinct.");
			const { machines, vm } = await resolveToolWorkspace(input);
			const result = await machines.exec(
				vm,
				`python3 -c ${quote(BUNDLE_SCRIPT)} ${quote(directory)} ${quote(JSON.stringify(ids))} ${quote(PAGE_SCRIPT)}`,
				15000,
			);
			if (result.exitCode)
				throw new Error("Check bundle is unavailable in this session.");
			const bundles = z
				.array(
					z.object({
						stdout: z.record(z.string(), z.unknown()),
						stderr: z.record(z.string(), z.unknown()),
					}),
				)
				.length(ids.length)
				.parse(JSON.parse(result.stdout));
			return bundles.map(({ stdout, stderr }, index) => {
				for (const page of [stdout, stderr]) {
					if (page.reference !== ids[index])
						throw new Error("Check reference mismatch.");
					if (page.verification)
						page.verification = verificationReceiptSchema.parse(
							page.verification,
						);
				}
				return {
					stdout: stdout as Awaited<ReturnType<typeof read>>,
					stderr: stderr as Awaited<ReturnType<typeof read>>,
				};
			});
		},
		async recordVerification(
			reference: string,
			receipt: z.infer<typeof verificationReceiptSchema>,
		) {
			input.signal.throwIfAborted();
			const id = z.uuid().parse(reference);
			const verified = verificationReceiptSchema.parse(receipt);
			const { machines, vm } = await resolveToolWorkspace(input);
			const result = await machines.exec(
				vm,
				`python3 -c ${quote(RECORD_VERIFICATION_SCRIPT)} ${quote(directory)} ${quote(id)} ${quote(JSON.stringify(verified))}`,
				15000,
			);
			if (result.exitCode)
				throw new Error("Could not retain source-bound verification evidence.");
		},
		async capture(command: string, timeoutSeconds = 20): Promise<AgentOutput> {
			input.signal.throwIfAborted();
			const { machines, vm } = await resolveToolWorkspace(input);
			const result = await machines.exec(
				vm,
				captureCommand(command, timeoutSeconds, randomUUID()),
				(timeoutSeconds + 5) * 1000,
			);
			if (result.exitCode)
				throw new Error("Could not capture tool output safely.");
			return JSON.parse(result.stdout) as AgentOutput;
		},
		readTool: tool({
			description:
				"Retrieve complete retained output and, when available, actual completion.status and completion.stopped from a tool's reference. Follow nextStart until null. Missing completion means status is unavailable, not success. Artifacts belong to this session and remain available while its VM exists. A stopped:output_limit result means execution was stopped and retained output is incomplete; do not treat it as complete evidence.",
			inputSchema: agentOutputPageSchema,
			execute: read,
		}),
	};
}
