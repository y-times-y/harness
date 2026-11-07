import { createHash, randomUUID } from "node:crypto";
import { openai } from "@ai-sdk/openai";
import { applyDiff } from "@openai/agents-core/utils";
import { type ModelMessage, type ToolSet, tool } from "ai";
import { z } from "zod";
import { checkExecutionGroups } from "../../domain/check-execution-groups";
import { clip } from "../../domain/clip";
import { publicToolDetail } from "../../domain/tool-detail";
import type { agentOutputArtifacts } from "./agent-output-artifacts";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { apiAgentImageTools } from "./api-agent-image-tools";
import { editDiagnostics } from "./edit-diagnostics";
import { runGuestCapability } from "./guest-node-capability";
import {
	LANGUAGE_INTELLIGENCE_SOURCE,
	languageQuery,
} from "./language-intelligence";
import { prepareRenameWrites, renameSources } from "./language-refactor";
import {
	APPLY_PATCH_LARK_GRAMMAR,
	applyPatchEdits,
	createsFromEmpty,
	FREEFORM_PATCH_HELP,
	PATCH_INPUT_HELP,
	type PatchFileChange,
	PatchInputError,
	parsePatchText,
	repositoryPatchPath,
} from "./patch-input";
import {
	archivedGuidanceDocuments,
	knownGuidanceDocuments,
} from "./repository-guidance";
import { inspectRepositoryChangesCommand } from "./repository-inspection";
import { repositoryToolPath } from "./repository-tool-path";
import { structuredCodeTools } from "./structured-code-reads";
import { editLanguage, warmEditDiagnostics } from "./warm-edit-diagnostics";

const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;

export const patchVerification = z
	.object({
		formatCommand: z.string().min(1).max(16_000).optional(),
		preflightCommands: z
			.array(z.string().min(1).max(16_000))
			.min(1)
			.max(8)
			.describe(
				"Fast prerequisites such as typechecking and focused tests. Final commands run only if every preflight command succeeds. Failed or stopped preflight leaves final checks unrun, never passed. At most eight commands across both stages.",
			)
			.optional(),
		commands: z.array(z.string().min(1).max(16_000)).min(1).max(8),
		groups: z
			.array(z.array(z.number().int().min(0).max(7)).min(1).max(2))
			.min(1)
			.max(8)
			.optional(),
		sourcePaths: z.array(z.string().min(1).max(2048)).min(1).max(8).optional(),
		outputView: z.enum(["full", "summary"]).default("summary"),
		parallelChecks: z
			.boolean()
			.default(false)
			.describe(
				"Overlap final checks only when verified independent with no shared generated-file/cache mutations. Preflight always runs in order.",
			),
		maxSeconds: z.number().int().min(1).max(120).default(120),
	})
	.refine(
		(request) =>
			request.commands.length + (request.preflightCommands?.length ?? 0) <= 8,
		"Verification supports at most eight total preflight and final commands.",
	)
	.superRefine((request, context) => {
		try {
			checkExecutionGroups(
				request.commands.length,
				request.groups,
				request.parallelChecks,
			);
		} catch {
			context.addIssue({
				code: "custom",
				message:
					"Verification groups must partition final commands exactly once and cannot combine with parallelChecks.",
			});
		}
	});

type RepositoryFileRead = {
	path: string;
	sha256?: string;
	content: string;
	truncated: boolean;
};
type RepositoryFileReadFailure = { path: string; error: "not-a-file" };
type RepositoryGuidanceReadReceipt = {
	path: string;
	sha256: string;
	nextStart: null;
} & (
	| { alreadyInContext: true }
	| {
			previouslyRead: true;
			archivedBody: ReturnType<
				typeof archivedGuidanceDocuments
			>[string]["archivedBody"];
	  }
);
type RepositoryFileBatch = (
	| RepositoryFileRead
	| RepositoryFileReadFailure
	| RepositoryGuidanceReadReceipt
)[];
type FileReadGuidance = {
	messages: readonly ModelMessage[];
	repeatCompleteBody: boolean;
};
type RepositoryFilePage = {
	path: string;
	sha256?: string;
	start: number;
	content: string;
	nextStart: number | null;
};

/** Characters one read, page or check returns by default (also the scripts' cap). */
const FILE_TOOL_CHARACTERS = 32_000;

const READ_ENVIRONMENT_REPORT_SCRIPT = `import json, os, stat, sys
start = int(sys.argv[1])
if not 0 <= start <= 10000000:
    raise ValueError('Report offset is outside the supported range')
try:
    descriptor = os.open('/tmp/ytimesy-environment.json', os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
except FileNotFoundError:
    print(json.dumps({'available': False}))
    sys.exit(0)
with os.fdopen(descriptor, 'r', encoding='utf-8') as handle:
    if not stat.S_ISREG(os.fstat(handle.fileno()).st_mode):
        raise ValueError('Environment report must be a regular file')
    handle.read(start)
    text = handle.read(${FILE_TOOL_CHARACTERS + 1})
print(json.dumps({'available': True, 'start': start, 'text': text[:${FILE_TOOL_CHARACTERS}], 'nextStart': start + ${FILE_TOOL_CHARACTERS} if len(text) > ${FILE_TOOL_CHARACTERS} else None}, ensure_ascii=False))`;

const READ_FILES_SCRIPT = `import hashlib, json, pathlib, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
paths = json.loads(sys.argv[2])
options = json.loads(sys.argv[3])
page = options['start'] is not None
start = options['start'] if page else 0
maximum = options['maxCharacters']
if not isinstance(maximum, int) or not 1 <= maximum <= 128000:
    raise ValueError('File read size is outside the supported range')
if not 0 <= start <= 10000000 or (page and len(paths) != 1):
    raise ValueError('File page is outside the supported range')
if not 1 <= len(paths) <= 8:
    raise ValueError('Request between one and eight files')
remaining = max(64000, maximum)
known_documents = options.get('knownDocuments', {})
archived_documents = options.get('archivedDocuments', {})
results = []
for path in paths:
    relative = pathlib.Path(path)
    if relative.is_absolute() or '.git' in relative.parts:
        raise ValueError('Path must be inside the repository and outside .git')
    target = (root / relative).resolve()
    if not target.is_relative_to(root) or '.git' in target.relative_to(root).parts:
        raise ValueError('Path must be a repository file outside .git')
    if not target.is_file():
        if page:
            raise ValueError('Requested repository file is unavailable')
        results.append({'path': path, 'error': 'not-a-file'})
        continue
    name = target.relative_to(root).as_posix()
    if start == 0 and (name in known_documents or name in archived_documents):
        digest = hashlib.sha256()
        with target.open('rb') as handle:
            for chunk in iter(lambda: handle.read(65536), b''):
                digest.update(chunk)
        sha256 = digest.hexdigest()
        if known_documents.get(name) == sha256:
            results.append({'path': path, 'sha256': sha256, 'alreadyInContext': True, 'nextStart': None})
            continue
        archived = archived_documents.get(name)
        if archived and archived['sha256'] == sha256:
            results.append({'path': path, 'sha256': sha256, 'previouslyRead': True, 'archivedBody': archived['archivedBody'], 'nextStart': None})
            continue
    before = target.stat()
    digest = hashlib.sha256()
    with target.open('rb') as handle:
        for chunk in iter(lambda: handle.read(65536), b''):
            digest.update(chunk)
    limit = min(maximum, remaining)
    with target.open('r', encoding='utf-8', newline='') as handle:
        handle.read(start)
        content = handle.read(limit + 1)
    after = target.stat()
    fingerprint = {'sha256': digest.hexdigest()} if (before.st_ino, before.st_size, before.st_mtime_ns, before.st_ctime_ns) == (after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns) else {}
    truncated = len(content) > limit
    content = content[:limit]
    remaining -= len(content)
    if page:
        results.append({'path': path, **fingerprint, 'start': start, 'content': content, 'nextStart': start + len(content) if truncated else None})
    else:
        results.append({'path': path, **fingerprint, 'content': content, 'truncated': truncated})
print(json.dumps(results[0] if page else results, ensure_ascii=False))`;

const EDIT_OPERATION_SCRIPT = `
relative = pathlib.Path(request['path'])
if relative.is_absolute() or '.git' in relative.parts:
    raise ValueError('Path must be inside the repository and outside .git')
requested = root / relative
if requested.is_symlink():
    raise ValueError('Symlink paths cannot be edited')
target = requested.resolve()
if not target.is_relative_to(root) or target == root:
    raise ValueError('Path outside repository')
if '.git' in target.relative_to(root).parts:
    raise ValueError('Resolved path must be outside .git')
if request['operation'] == 'create':
    if target.exists() or target.is_symlink():
        raise ValueError('File already exists; inspect it before editing')
    content = request['content']
    mode = 0o644
else:
    if not target.is_file() or target.is_symlink():
        raise ValueError('File is unavailable or is a symlink')
    with target.open('r', encoding='utf-8', newline='') as handle:
        existing = handle.read()
    mode = stat.S_IMODE(target.stat().st_mode)
    if request['operation'] in ('write', 'delete', 'move'):
        if hashlib.sha256(existing.encode()).hexdigest() != request['expectedSha256']:
            raise ValueError('File changed since inspection; read the latest file before patching')
        if request['operation'] == 'delete':
            if validate_only:
                return {'path': request['path']}
            target.unlink()
            return {'path': request['path'], 'deleted': True}
        content = request['content']
    else:
        old = request['old']
        if existing.count(old) != 1:
            raise ValueError('Expected text must occur exactly once; inspect the latest file')
        content = existing.replace(old, request['new'], 1)
if request['operation'] == 'move':
    destination_relative = pathlib.Path(request['newPath'])
    if destination_relative.is_absolute() or '.git' in destination_relative.parts or '..' in destination_relative.parts:
        raise ValueError('Invalid move destination')
    destination = root / destination_relative
    if destination.exists() or destination.is_symlink():
        raise ValueError('Move destination already exists')
    if not destination.parent.is_dir() or destination.parent.resolve() != destination.parent or not destination.parent.resolve().is_relative_to(root):
        raise ValueError('Move destination parent must exist inside the repository without symlinks')
    if validate_only:
        return {'path': request['path']}
    descriptor, temporary = tempfile.mkstemp(prefix='.ytimesy-move-', dir=destination.parent)
    try:
        with os.fdopen(descriptor, 'w', encoding='utf-8', newline='') as handle:
            handle.write(content)
        os.chmod(temporary, mode)
        os.link(temporary, destination)
        target.unlink()
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return {'path': request['newPath'], 'previousPath': request['path'], 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'diagnosticSource': content if len(content) <= ${FILE_TOOL_CHARACTERS} else None}
if validate_only:
    return {'path': request['path']}
target.parent.mkdir(parents=True, exist_ok=True)
if not target.parent.resolve().is_relative_to(root):
    raise ValueError('Parent directory escaped repository')
descriptor, temporary = tempfile.mkstemp(prefix='.ytimesy-edit-', dir=target.parent)
try:
    with os.fdopen(descriptor, 'w', encoding='utf-8') as handle:
        handle.write(content)
    os.chmod(temporary, mode)
    os.replace(temporary, target)
finally:
    if os.path.exists(temporary):
        os.unlink(temporary)
return {'path': request['path'], 'sha256': hashlib.sha256(content.encode()).hexdigest(), 'diagnosticSource': content if len(content) <= ${FILE_TOOL_CHARACTERS} else None}`;

/**
 * Python (needs fcntl, hashlib, os, pathlib, stat, tempfile and a resolved
 * `root`): takes the repository's edit lock and defines
 * `apply_edit(request, validate_only=False)`, one checked edit relative to
 * `root`: no absolute paths or .git, no symlinks, no escape from `root`,
 * stale-content refusal, atomic replace with the temp file always removed.
 * The lean surfaces' file writer uses the same function.
 */
export const LOCKED_APPLY_EDIT = `lock = open('/tmp/ytimesy-edit-lock-' + hashlib.sha256(str(root).encode()).hexdigest(), 'a')
fcntl.flock(lock, fcntl.LOCK_EX)
def apply_edit(request, validate_only=False):
${EDIT_OPERATION_SCRIPT.trim()
	.split("\n")
	.map((line) => `    ${line}`)
	.join("\n")}`;

const EDIT_SCRIPT = `import fcntl, hashlib, json, os, pathlib, stat, sys, tempfile
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
${LOCKED_APPLY_EDIT}
with open(sys.argv[2], encoding='utf-8') as handle:
    request = json.load(handle)
if isinstance(request, dict) and 'preflight' in request:
    requests = request['preflight']
    for operation in requests:
        apply_edit(operation, validate_only=True)
    request = requests
if isinstance(request, list):
    completed = []
    result = {'completed': completed, 'failedPath': None, 'unattemptedPaths': []}
    for index, operation in enumerate(request):
        try:
            completed.append(apply_edit(operation))
        except Exception as error:
            result.update({'failedPath': operation['path'], 'error': str(error), 'unattemptedPaths': [pending['path'] for pending in request[index + 1:]]})
            break
else:
    result = apply_edit(request)
print(json.dumps(result, ensure_ascii=False))`;

type FileEditReceipt = {
	path: string;
	sha256?: string;
	deleted?: boolean;
	diagnosticSource?: string | null;
	languageFeedback?: Awaited<ReturnType<typeof warmEditDiagnostics>>;
};
type BatchEditReceipt = {
	completed: FileEditReceipt[];
	failedPath: string | null;
	unattemptedPaths: string[];
	error?: string;
};

async function publicEditReceipt(edited: FileEditReceipt) {
	return {
		path: edited.path,
		...(edited.languageFeedback
			? { languageFeedback: edited.languageFeedback }
			: {}),
		...(edited.deleted
			? { deleted: true }
			: {
					sha256: edited.sha256,
					...(await editDiagnostics(
						edited.path,
						edited.diagnosticSource ?? undefined,
					)),
				}),
	};
}

export function apiAgentFileTools(
	input: AgentToolWorkspaceInput & {
		readOnly: boolean;
		nativePatch?: boolean;
		/**
		 * The apply_patch shape for GPT models on a Responses route: a
		 * freeform (custom) tool constrained by its Lark grammar, not JSON.
		 */
		freeformPatch?: boolean;
		output?: ReturnType<typeof agentOutputArtifacts>;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
		verifyBatch?: (
			request: z.infer<typeof patchVerification>,
			id: string,
		) => Promise<unknown>;
	},
): ToolSet {
	const { signal, once } = input;
	/** Patch headers may name repository files by absolute path (as the apply_patch format allows). */
	const repositoryRoot = async () => (await resolveToolWorkspace(input)).cwd;
	function readRepositoryFiles(
		paths: string[],
		start: number,
		maxCharacters?: number,
	): Promise<RepositoryFilePage>;
	function readRepositoryFiles(
		paths: string[],
		start: undefined,
		maxCharacters?: number,
		guidance?: FileReadGuidance,
	): Promise<RepositoryFileBatch>;
	function readRepositoryFiles(
		paths: string[],
		start: number,
		maxCharacters?: number,
		guidance?: FileReadGuidance,
	): Promise<RepositoryFilePage | RepositoryGuidanceReadReceipt>;
	async function readRepositoryFiles(
		paths: string[],
		start?: number,
		maxCharacters = FILE_TOOL_CHARACTERS,
		guidance?: FileReadGuidance,
	): Promise<
		RepositoryFileBatch | RepositoryFilePage | RepositoryGuidanceReadReceipt
	> {
		signal.throwIfAborted();
		const { machines, vm, cwd } = await resolveToolWorkspace(input);
		const result = await machines.exec(
			vm,
			`python3 -c ${quote(READ_FILES_SCRIPT)} ${quote(cwd)} ${quote(JSON.stringify(paths))} ${quote(JSON.stringify({ start: start ?? null, maxCharacters, ...(guidance && !guidance.repeatCompleteBody ? { knownDocuments: knownGuidanceDocuments(guidance.messages), archivedDocuments: archivedGuidanceDocuments(guidance.messages) } : {}) }))}`,
			15_000,
		);
		if (result.exitCode)
			throw new Error("Could not safely read requested repository files.");
		return JSON.parse(result.stdout) as
			| RepositoryFileBatch
			| RepositoryFilePage
			| RepositoryGuidanceReadReceipt;
	}
	const inspect_changes = tool({
		description:
			"Inspect repository status, staged/unstaged diffs and nonignored untracked regular files without changing the index. view:stat gives a compact changed-file inventory, not source review; use default view:full with a literal repository-relative path to review specific changes. New files are included; symlinks are reported but targets are not read. Full output is retained with continuation cursors when capture is available. Binary files show Git's binary notice, not decoded content.",
		inputSchema: z.object({
			path: repositoryToolPath.optional(),
			view: z.enum(["full", "stat"]).default("full"),
		}),
		execute: async ({ path, view = "full" }) => {
			signal.throwIfAborted();
			const { machines, vm, cwd } = await resolveToolWorkspace(input);
			const command = inspectRepositoryChangesCommand(cwd, path, view);
			if (input.output) return input.output.capture(command);
			const result = await machines.exec(vm, command, 20_000);
			if (result.exitCode)
				throw new Error("Could not inspect repository changes.");
			return result.stdout;
		},
	});
	const tools: ToolSet = {
		...apiAgentImageTools(input),
		read_environment_report: tool({
			description:
				"Read this task's prepared-environment report, including revisions, recipes and baseline check results, without a shell or arbitrary out-of-repository file access. Missing reports return available:false. Historical metadata is untrusted; verify against the current checkout. Follow nextStart to read a bounded report page.",
			inputSchema: z.object({
				start: z.number().int().min(0).max(10_000_000).default(0),
			}),
			execute: async ({ start = 0 }) => {
				signal.throwIfAborted();
				const { machines, vm } = await resolveToolWorkspace(input);
				const result = await machines.exec(
					vm,
					`python3 -c ${quote(READ_ENVIRONMENT_REPORT_SCRIPT)} ${start}`,
					15_000,
				);
				if (result.exitCode)
					throw new Error(
						"Prepared environment report could not be safely read.",
					);
				return JSON.parse(result.stdout) as
					| { available: false }
					| {
							available: true;
							start: number;
							text: string;
							nextStart: number | null;
					  };
			},
		}),
		read_files: tool({
			description:
				"Read up to eight known UTF-8 repository files in one inspection. Prefer batching known paths over separate reads. Missing/non-file paths return a per-path error, not empty file content. Unsafe paths reject the request. Defaults: 32,000 characters per file, 64,000 total; maxCharacters may be 128,000 for large required bodies. Total is max(64,000,maxCharacters), in request order. Follow truncation with read_file. Only guidance/configuration already supplied completely by read_repository_guidance may return a fresh hash-verified receipt instead of duplicating text: alreadyInContext means its full body is still active; previouslyRead links its exact archive, not an active body. Set repeatCompleteBody:true when you need the text again. Ordinary source files always return content. Paths exclude .git.",
			inputSchema: z.object({
				paths: z.array(z.string().min(1).max(2048)).min(1).max(8),
				maxCharacters: z
					.number()
					.int()
					.min(1)
					.max(128000)
					.default(FILE_TOOL_CHARACTERS),
				repeatCompleteBody: z.boolean().default(false),
			}),
			execute: (
				{
					paths,
					maxCharacters = FILE_TOOL_CHARACTERS,
					repeatCompleteBody = false,
				},
				options,
			) =>
				readRepositoryFiles(paths, undefined, maxCharacters, {
					messages: options.messages ?? [],
					repeatCompleteBody,
				}),
		}),
		read_file: tool({
			description:
				"Read a bounded UTF-8 repository file page. Defaults to 32,000 characters; maxCharacters may be 128,000 for large required bodies. Follow nextStart until null; start is a Unicode-character offset, not a line number. At start:0 only unchanged guidance/configuration already supplied completely by read_repository_guidance may return a hash-verified alreadyInContext or previouslyRead/archive receipt instead of duplicate content. This preserves prior complete reading; it is not missing-file content. Set repeatCompleteBody:true for actual text when a detail has been forgotten. Continuations and ordinary source files always return content. Paths exclude .git. Prefer read_files for several known paths.",
			inputSchema: z.object({
				path: z.string().min(1).max(2048),
				start: z.number().int().min(0).max(10_000_000).default(0),
				maxCharacters: z
					.number()
					.int()
					.min(1)
					.max(128000)
					.default(FILE_TOOL_CHARACTERS),
				repeatCompleteBody: z.boolean().default(false),
			}),
			execute: (
				{
					path,
					start = 0,
					maxCharacters = FILE_TOOL_CHARACTERS,
					repeatCompleteBody = false,
				},
				options,
			) =>
				readRepositoryFiles([path], start, maxCharacters, {
					messages: options.messages ?? [],
					repeatCompleteBody,
				}),
		}),
		inspect_changes,
		verify_changes: tool({
			description:
				"Check the repository diff for whitespace errors and report changed files. Run relevant project tests separately before claiming completion.",
			inputSchema: z.object({}),
			execute: async () => {
				signal.throwIfAborted();
				const { machines, vm, cwd } = await resolveToolWorkspace(input);
				const result = await machines.exec(
					vm,
					`git -C ${quote(cwd)} diff --check && git -C ${quote(cwd)} diff --cached --check && git -C ${quote(cwd)} status --short`,
					20_000,
				);
				return {
					passed: result.exitCode === 0,
					output: clip(
						`${result.stdout}${result.stderr}`,
						FILE_TOOL_CHARACTERS,
						"\n[output truncated]",
					),
				};
			},
		}),
	};
	Object.assign(tools, structuredCodeTools(input));
	if (input.readOnly) return tools;
	async function edit(
		id: string,
		request: Record<string, string>,
	): Promise<unknown> {
		return once(id, () => writeEdit(request));
	}
	async function writeEdit(request: Record<string, string>): Promise<unknown> {
		return publicEditReceipt(
			(await writeGuestEdits(request)) as FileEditReceipt,
		);
	}
	async function writeGuestEdits(
		request: Record<string, string> | Record<string, string>[],
		preflight = false,
	): Promise<FileEditReceipt | BatchEditReceipt> {
		signal.throwIfAborted();
		const { machines, vm, cwd } = await resolveToolWorkspace(input);
		const payload = `/tmp/ytimesy-api-edit-${randomUUID()}.json`;
		await machines.writeTextFile(
			vm,
			payload,
			JSON.stringify(preflight ? { preflight: request } : request),
		);
		try {
			const result = await machines.exec(
				vm,
				`python3 -c ${quote(EDIT_SCRIPT)} ${quote(cwd)} ${quote(payload)}`,
				20_000,
			);
			if (result.exitCode)
				throw new Error(result.stderr.slice(-1200) || "Could not edit file.");
			const receipt = JSON.parse(result.stdout) as
				| FileEditReceipt
				| BatchEditReceipt;
			const completed = "completed" in receipt ? receipt.completed : [receipt];
			const unavailableLanguages = new Set<string>();
			for (const edited of completed) {
				const language = editLanguage(edited.path);
				if (!language) continue;
				if (unavailableLanguages.has(language)) {
					edited.languageFeedback = { available: false };
					continue;
				}
				edited.languageFeedback = await warmEditDiagnostics(
					{ machines, vm, cwd },
					edited,
					signal,
				);
				if (edited.languageFeedback?.available === false)
					unavailableLanguages.add(language);
			}
			return receipt;
		} finally {
			await machines
				.exec(vm, `rm -f ${quote(payload)}`, 10_000)
				.catch(() => {});
		}
	}

	tools.rename_symbol = tool({
		description:
			"Apply a language-server symbol rename across one to eight existing repository files. Supply 1-based UTF-16 position and newName. Reuses the warm server, obtains its edits and source snapshots, validates ranges, then preflights every source hash under our repository edit lock. Read the completed/failedPath receipt: filesystem failures can leave partial writes; never blindly replay. Does not move files or accept resource operations. Run project checks afterward; language edits do not prove behavior. Available only to writable builders.",
		inputSchema: languageQuery
			.omit({ operation: true })
			.extend({ newName: z.string().min(1).max(200) }),
		execute: (args, options) =>
			once(options.toolCallId, async () => {
				const request = languageQuery.parse({
					...args,
					operation: "rename_preview",
				});
				const workspace = await resolveToolWorkspace(input);
				const sources = await runGuestCapability(
					workspace,
					"language",
					LANGUAGE_INTELLIGENCE_SOURCE,
					{ ...request, cwd: workspace.cwd, includeRenameSources: true },
					renameSources,
					signal,
				);
				const writes = prepareRenameWrites(sources);
				const receipt = (await writeGuestEdits(
					writes,
					true,
				)) as BatchEditReceipt;
				return {
					completed: await Promise.all(
						receipt.completed.map(publicEditReceipt),
					),
					failedPath: receipt.failedPath,
					unattemptedPaths: receipt.unattemptedPaths,
					...(receipt.error ? { error: publicToolDetail(receipt.error) } : {}),
				};
			}),
	});
	tools.apply_code_action = tool({
		description:
			"Apply a textual language-server code action previously returned by inspect_code operation code_actions. Repeat its selection/kind and supply index plus sha256. Requeries and rejects changed/disabled actions, commands and server resource operations. All source hashes preflight under the edit lock; inspect partial-failure receipts and run project checks afterward.",
		inputSchema: languageQuery.omit({ operation: true, newName: true }).extend({
			actionIndex: z.number().int().min(0).max(99),
			actionSha256: z.string().regex(/^[a-f0-9]{64}$/),
		}),
		execute: (args, options) =>
			once(options.toolCallId, async () => {
				const workspace = await resolveToolWorkspace(input);
				const sources = await runGuestCapability(
					workspace,
					"language",
					LANGUAGE_INTELLIGENCE_SOURCE,
					{
						...args,
						operation: "code_actions",
						cwd: workspace.cwd,
						includeRenameSources: true,
					},
					renameSources,
					signal,
				);
				const receipt = (await writeGuestEdits(
					prepareRenameWrites(sources),
					true,
				)) as BatchEditReceipt;
				return {
					...receipt,
					completed: await Promise.all(
						receipt.completed.map(publicEditReceipt),
					),
				};
			}),
	});
	tools.rename_file = tool({
		description:
			"Move one existing source file and update semantic imports/references through workspace/willRenameFiles. Requires a configured server with file-move support and an existing destination parent. Never overwrites a destination. Preflights every source hash and destination under the edit lock, preserves source permissions, and rejects server resource operations. Inspect partial-failure receipts and run checks afterward.",
		inputSchema: z.object({
			path: repositoryToolPath,
			newPath: repositoryToolPath,
		}),
		execute: (args, options) =>
			once(options.toolCallId, async () => {
				if (editLanguage(args.path) !== editLanguage(args.newPath))
					throw new Error("Move must preserve the configured source language.");
				const workspace = await resolveToolWorkspace(input);
				const sources = await runGuestCapability(
					workspace,
					"language",
					LANGUAGE_INTELLIGENCE_SOURCE,
					{
						...args,
						operation: "rename_file_preview",
						line: 1,
						column: 1,
						cwd: workspace.cwd,
						includeRenameSources: true,
					},
					renameSources,
					signal,
				);
				const writes = prepareRenameWrites(sources);
				const original = writes.find((file) => file.path === args.path);
				if (!original) throw new Error("Move source snapshot is missing.");
				const move = { ...original, operation: "move", newPath: args.newPath };
				const receipt = (await writeGuestEdits(
					[...writes.filter((file) => file.path !== args.path), move],
					true,
				)) as BatchEditReceipt;
				return {
					...receipt,
					completed: await Promise.all(
						receipt.completed.map(publicEditReceipt),
					),
				};
			}),
	});

	tools.create_file = tool({
		description:
			"Create a new UTF-8 repository file. Fails if it already exists; never overwrites.",
		inputSchema: z.object({
			path: z.string().min(1).max(2048),
			content: z.string().max(100_000),
		}),
		execute: ({ path, content }, options) =>
			edit(options.toolCallId, { operation: "create", path, content }),
	});
	tools.replace_text = tool({
		description:
			"Replace one exact occurrence in an existing UTF-8 repository file. Fails if the file changed or the match is ambiguous.",
		inputSchema: z.object({
			path: z.string().min(1).max(2048),
			old: z.string().min(1).max(16_000),
			new: z.string().max(60_000),
		}),
		execute: ({ path, old, new: replacement }, options) =>
			edit(options.toolCallId, {
				operation: "replace",
				path,
				old,
				new: replacement,
			}),
	});
	const patchOperation = z.discriminatedUnion("type", [
		z.object({
			type: z.literal("create_file"),
			path: z.string().min(1).max(2048),
			diff: z.string().max(100_000),
		}),
		z.object({
			type: z.literal("update_file"),
			path: z.string().min(1).max(2048),
			diff: z.string().max(100_000),
		}),
		z.object({
			type: z.literal("delete_file"),
			path: z.string().min(1).max(2048),
		}),
	]);
	const preparePatch = async (
		operation: z.infer<typeof patchOperation>,
	): Promise<Record<string, string>> => {
		const validated = patchOperation.parse(operation);
		if (validated.type === "create_file") {
			const created = applyDiff("", validated.diff, "create");
			// The maintained parser strips the terminal diff newline; preserve an
			// explicitly supplied terminator without changing unterminated content.
			const content = validated.diff.endsWith("\n") ? `${created}\n` : created;
			if (content.length > 1_000_000)
				throw new Error("Patch result exceeds the supported file size.");
			return { operation: "create", path: validated.path, content };
		}
		// Read through the same path boundary, then compare-and-swap under the guest edit lock.
		let content = "";
		let start: number | null = 0;
		do {
			const page: RepositoryFilePage = await readRepositoryFiles(
				[validated.path],
				start,
			);
			content += page.content;
			if (content.length > 1_000_000)
				throw new Error("Patch source exceeds the supported file size.");
			start = page.nextStart;
		} while (start !== null);
		const expectedSha256 = createHash("sha256").update(content).digest("hex");
		if (validated.type === "delete_file")
			return {
				operation: "delete",
				path: validated.path,
				expectedSha256,
			};
		const patched = applyDiff(content, validated.diff);
		if (patched.length > 1_000_000)
			throw new Error("Patch result exceeds the supported file size.");
		return {
			operation: "write",
			path: validated.path,
			expectedSha256,
			content: patched,
		};
	};
	const applyPatch = async (operation: z.infer<typeof patchOperation>) =>
		writeEdit(await preparePatch(operation));
	const patchBatch = z
		.array(patchOperation)
		.min(1)
		.max(8)
		.superRefine((operations, context) => {
			const paths = new Set<string>();
			let characters = 0;
			for (const operation of operations) {
				const segments = operation.path.split("/");
				if (
					operation.path.startsWith("/") ||
					operation.path.includes("\\") ||
					operation.path.includes("\0") ||
					segments.some(
						(part) => !part || part === "." || part === ".." || part === ".git",
					) ||
					paths.has(operation.path)
				)
					context.addIssue({
						code: "custom",
						message:
							"Batch paths must be distinct repository-relative files outside .git.",
					});
				paths.add(operation.path);
				characters += "diff" in operation ? operation.diff.length : 0;
			}
			if (characters > 200_000)
				context.addIssue({
					code: "custom",
					message: "Combined patch exceeds the supported batch size.",
				});
		});
	tools.apply_patches = tool({
		description:
			"Apply up to eight distinct files in one call using headerless V4A operations. Parses every diff and reads update sources before writing. Each file uses stale-edit protection. This is not a transaction: on a write failure, reports completed files and stops; inspect that result before retrying. Use for a coherent multi-file implementation instead of separate create_file calls. " +
			(input.verifyBatch
				? "When all edits and required commands are known, optional verification formats after successful edits, then runs independent checks through run_checks on that stable tree. Formatting failure prevents checks. Completed hashes describe the edit stage, before formatting. Every verification output retains actual exit status and full-output references; failures still require repair and affected checks rerun. "
				: "Batch verification is unavailable in this runtime; call run_checks separately, or compose_tools for ordered edits and checks. ") +
			"Do not edit while this call runs; inspect final changes afterward.",
		inputSchema: z.object({
			operations: patchBatch,
			verification: input.verifyBatch
				? patchVerification.optional()
				: z.never().optional(),
		}),
		execute: ({ operations, verification }, options) =>
			once(options.toolCallId, async () => {
				if (verification && !input.verifyBatch)
					throw new Error(
						"Batch verification is unavailable; no files were changed.",
					);
				const verificationRequest = verification
					? patchVerification.parse(verification)
					: undefined;
				const validated = patchBatch.parse(operations);
				const requests = await Promise.all(validated.map(preparePatch));
				const receipt = (await writeGuestEdits(requests)) as BatchEditReceipt;
				return {
					completed: await Promise.all(
						receipt.completed.map(publicEditReceipt),
					),
					failedPath: receipt.failedPath,
					unattemptedPaths: receipt.unattemptedPaths,
					...(receipt.error ? { error: publicToolDetail(receipt.error) } : {}),
					...(verificationRequest &&
					input.verifyBatch &&
					!receipt.failedPath &&
					!receipt.error &&
					!receipt.unattemptedPaths.length
						? {
								verification: await input.verifyBatch(
									verificationRequest,
									options.toolCallId,
								),
							}
						: {}),
				};
			}),
	});
	tools.apply_patch = input.freeformPatch
		? openai.tools.customTool({
				description:
					"The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
				format: {
					type: "grammar",
					syntax: "lark",
					definition: APPLY_PATCH_LARK_GRAMMAR,
				},
				execute: (patch: string, options) =>
					once(options.toolCallId, async () => {
						try {
							return await applyFileChanges(
								parsePatchText(patch, undefined, await repositoryRoot()),
							);
						} catch (error) {
							const message =
								error instanceof Error
									? error.message
									: "The patch could not be applied.";
							throw new Error(
								`${message}${error instanceof PatchInputError ? " No files were changed." : ""}\n\n${FREEFORM_PATCH_HELP}`,
							);
						}
					}),
			})
		: input.nativePatch
			? openai.tools.applyPatch({
					execute: async ({ operation }, options) => {
						try {
							return {
								status: "completed" as const,
								output: JSON.stringify(
									await once(options.toolCallId, () => applyPatch(operation)),
								),
							};
						} catch (error) {
							return {
								status: "failed" as const,
								output: publicToolDetail(
									error instanceof Error
										? error.message
										: "Patch failed; inspect the file before retrying.",
								),
							};
						}
					},
				})
			: tool({
					description:
						"Edit files. Pass one of: patch (a unified/git diff, a '*** Begin Patch' envelope with Add/Update/Delete File sections, or SEARCH/REPLACE blocks with path); path plus content to write a whole file; or operation (one V4A create_file/update_file/delete_file). Multi-file patches apply in order. Reads latest content; context may drift in line numbers or whitespace but must match exactly one place. Rejects stale edits, escapes and symlinks.",
					inputSchema: z.object({
						operation: z
							.union([patchOperation, z.string().max(200_000)])
							.optional()
							.describe("One V4A operation object."),
						patch: z
							.string()
							.max(200_000)
							.optional()
							.describe(
								"Patch text: unified diff, *** Begin Patch envelope, or SEARCH/REPLACE blocks.",
							),
						path: z
							.string()
							.min(1)
							.max(2048)
							.optional()
							.describe(
								"Target file for content, or for SEARCH/REPLACE blocks and hunks without file headers.",
							),
						content: z
							.string()
							.max(1_000_000)
							.optional()
							.describe("Complete new file content, written to path."),
					}),
					execute: (args, options) =>
						once(options.toolCallId, () => applyFlexiblePatch(args)),
				});
	async function applyFlexiblePatch(args: {
		operation?: z.infer<typeof patchOperation> | string;
		patch?: string;
		path?: string;
		content?: string;
	}): Promise<unknown> {
		const patchText =
			typeof args.operation === "string" ? args.operation : args.patch;
		const operation =
			typeof args.operation === "object" ? args.operation : undefined;
		const forms = [operation, patchText, args.content].filter(
			(value) => value !== undefined,
		).length;
		try {
			if (forms !== 1)
				throw new PatchInputError(
					forms
						? "Pass exactly one of operation, patch, or path with content."
						: "No edit was supplied.",
				);
			if (operation) {
				let request: Record<string, string>;
				try {
					request = await preparePatch(operation);
				} catch (error) {
					// Keep the maintained V4A applier first; fall back only when it rejects
					// a diff written in another accepted format.
					if (operation.type === "delete_file" || !operation.diff) throw error;
					let changes: PatchFileChange[];
					try {
						changes = parsePatchText(
							operation.diff,
							operation.path,
							await repositoryRoot(),
						);
					} catch {
						throw error;
					}
					return await applyFileChanges(changes);
				}
				return await writeEdit(request);
			}
			if (patchText !== undefined)
				return await applyFileChanges(
					parsePatchText(patchText, args.path, await repositoryRoot()),
				);
			if (!args.path)
				throw new PatchInputError("content needs a path to write.");
			return await applyFileChanges([
				{
					type: "write",
					path: repositoryPatchPath(args.path, await repositoryRoot()),
					content: args.content as string,
				},
			]);
		} catch (error) {
			const message =
				error instanceof Error
					? error.message
					: "The patch could not be applied.";
			throw new Error(
				`${message}${error instanceof PatchInputError ? " No files were changed." : ""}\n\n${PATCH_INPUT_HELP}`,
			);
		}
	}
	async function readOptionalRepositoryFile(
		path: string,
	): Promise<string | null> {
		const [entry] = await readRepositoryFiles([path], undefined, 128_000);
		if (!entry || "error" in entry) return null;
		if (!("content" in entry))
			throw new Error(`Could not read ${path} for patching.`);
		let content = entry.content;
		let start: number | null = entry.truncated ? content.length : null;
		while (start !== null) {
			const page: RepositoryFilePage = await readRepositoryFiles(
				[path],
				start,
				128_000,
			);
			content += page.content;
			if (content.length > 1_000_000)
				throw new PatchInputError(
					"Patch source exceeds the supported file size.",
				);
			start = page.nextStart;
		}
		return content;
	}
	async function applyFileChanges(changes: PatchFileChange[]) {
		const states = new Map<
			string,
			{ original: string | null; current: string | null }
		>();
		const load = async (path: string) => {
			let state = states.get(path);
			if (!state) {
				if (states.size >= 16)
					throw new PatchInputError(
						"A patch may change at most 16 files; split it into several calls.",
					);
				const original = await readOptionalRepositoryFile(path);
				state = { original, current: original };
				states.set(path, state);
			}
			return state;
		};
		// Apply every change in memory first so a bad hunk changes nothing.
		for (const change of changes) {
			const state = await load(change.path);
			if (change.type === "create") {
				if (state.current !== null)
					throw new PatchInputError(
						`${change.path} already exists; update it with hunks or replace it with {path, content}.`,
					);
				state.current = change.content;
			} else if (change.type === "write") state.current = change.content;
			else if (change.type === "delete") {
				if (state.current === null)
					throw new PatchInputError(`${change.path} does not exist.`);
				state.current = null;
			} else {
				if (state.current === null && !createsFromEmpty(change.edits))
					throw new PatchInputError(
						`${change.path} does not exist; create it with '--- /dev/null', '*** Add File:' or {path, content}.`,
					);
				const updated = applyPatchEdits(
					state.current ?? "",
					change.edits,
					change.path,
				);
				if (change.moveTo && change.moveTo !== change.path) {
					const destination = await load(change.moveTo);
					if (destination.current !== null)
						throw new PatchInputError(`${change.moveTo} already exists.`);
					destination.current = updated;
					state.current = null;
				} else state.current = updated;
			}
			if ((state.current?.length ?? 0) > 1_000_000)
				throw new PatchInputError(
					"Patch result exceeds the supported file size.",
				);
		}
		const requests: Record<string, string>[] = [];
		const unchanged: string[] = [];
		for (const [path, { original, current }] of states) {
			if (original === current) {
				if (original !== null) unchanged.push(path);
				continue;
			}
			const expectedSha256 =
				original === null
					? undefined
					: createHash("sha256").update(original).digest("hex");
			if (current === null)
				requests.push({
					operation: "delete",
					path,
					expectedSha256: expectedSha256 as string,
				});
			else if (expectedSha256)
				requests.push({
					operation: "write",
					path,
					expectedSha256,
					content: current,
				});
			else requests.push({ operation: "create", path, content: current });
		}
		const receipt = requests.length
			? ((await writeGuestEdits(requests)) as BatchEditReceipt)
			: { completed: [], failedPath: null, unattemptedPaths: [] };
		return {
			completed: await Promise.all(receipt.completed.map(publicEditReceipt)),
			failedPath: receipt.failedPath,
			unattemptedPaths: receipt.unattemptedPaths,
			...(unchanged.length ? { unchanged } : {}),
			...(receipt.error
				? {
						error: `${publicToolDetail(receipt.error)}. Applied: ${receipt.completed.map((file) => file.path).join(", ") || "none"}. Not applied: ${[receipt.failedPath, ...receipt.unattemptedPaths].filter(Boolean).join(", ")}. Inspect those files before retrying.`,
					}
				: {}),
		};
	}
	return tools;
}
