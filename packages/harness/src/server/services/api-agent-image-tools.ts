import { detectMediaType } from "@ai-sdk/provider-utils";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { AGENT_ATTACHMENT_DIRECTORY } from "../../domain/message-attachment";
import { posixShellCommand } from "../../domain/posix-command";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { repositoryToolPath } from "./repository-tool-path";

const READ_IMAGE = `import base64, hashlib, json, os, pathlib, stat, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
relative = pathlib.Path(sys.argv[2])
if relative.is_absolute() or any(part in ('..', '.git') for part in relative.parts):
    raise ValueError('Repository-relative image path required')
directory = os.open(root, os.O_RDONLY | os.O_DIRECTORY)
try:
    for part in relative.parts[:-1]:
        child = os.open(part, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=directory)
        os.close(directory)
        directory = child
    descriptor = os.open(relative.parts[-1], os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK, dir_fd=directory)
finally:
    os.close(directory)
with os.fdopen(descriptor, 'rb') as handle:
    info = os.fstat(handle.fileno())
    if not stat.S_ISREG(info.st_mode) or info.st_size > 3000000:
        raise ValueError('Image must be a regular file no larger than 3 MB')
    data = handle.read(3000001)
if not data or len(data) > 3000000: raise ValueError('Invalid image size')
print(json.dumps({'path': str(relative), 'sha256': hashlib.sha256(data).hexdigest(), 'base64': base64.b64encode(data).decode()}))`;

const ATTACHED = `${AGENT_ATTACHMENT_DIRECTORY}/`;

/** Repository images, or one attached file: `<attachment id>/<name>` under the attachment directory. */
const viewableImagePath = z
	.string()
	.min(1)
	.max(2048)
	.refine(
		(path) =>
			path.startsWith(ATTACHED)
				? /^[a-f0-9-]{36}\/[^/\\\0]+$/.test(path.slice(ATTACHED.length)) &&
					!path.endsWith("/..") &&
					!path.endsWith("/.")
				: repositoryToolPath.safeParse(path).success,
		"Use a repository-relative path, or the absolute path of an attached file.",
	);

/** Pixels use the same model-content contract as browser screenshots, not JSON-only text. */
export function apiAgentImageTools(
	input: AgentToolWorkspaceInput & { signal: AbortSignal },
): ToolSet {
	return {
		view_image: tool({
			description:
				"Visually inspect a PNG, JPEG, GIF or WebP (up to 3 MB): a repository-relative path, such as a Playwright screenshot, generated test image or design asset, or the absolute path of a file the user attached. Returns actual pixels to vision-capable models. No SVG, URLs, symlinks or other out-of-repository files. Do not expose credentials or private screenshots unnecessarily.",
			inputSchema: z.object({ path: viewableImagePath }),
			execute: async ({ path }) => {
				input.signal.throwIfAborted();
				viewableImagePath.parse(path);
				const { machines, vm, cwd } = await resolveToolWorkspace(input);
				const attached = path.startsWith(ATTACHED);
				const result = await machines.exec(
					vm,
					posixShellCommand([
						"python3",
						"-c",
						READ_IMAGE,
						attached ? AGENT_ATTACHMENT_DIRECTORY : cwd,
						attached ? path.slice(ATTACHED.length) : path,
					]),
					15000,
				);
				input.signal.throwIfAborted();
				if (result.exitCode || result.stdout.length > 4100000)
					throw new Error("Could not safely read repository image.");
				const output = z
					.object({
						path: z.string(),
						sha256: z.string().regex(/^[a-f0-9]{64}$/),
						base64: z.string().min(1).max(4000000),
					})
					.parse(JSON.parse(result.stdout));
				const mediaType = detectMediaType({
					data: output.base64,
					topLevelType: "image",
				});
				if (
					!mediaType ||
					!["image/png", "image/jpeg", "image/gif", "image/webp"].includes(
						mediaType,
					)
				)
					throw new Error(
						"Unsupported image content; use PNG, JPEG, GIF or WebP.",
					);
				return { ...output, mediaType };
			},
			toModelOutput: ({ output }) => ({
				type: "content",
				value: [
					{
						type: "text",
						text: `Image ${output.path} (sha256 ${output.sha256})`,
					},
					{
						type: "file",
						data: { type: "data", data: output.base64 },
						mediaType: output.mediaType,
					},
				],
			}),
		}),
	};
}
