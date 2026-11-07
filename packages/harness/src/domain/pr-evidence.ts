import { z } from "zod";
import { insertBeforePullRequestFooter } from "./pull-request-footer";

/**
 * Pull request evidence (harness variant prEvidence=on): screenshots, a short
 * screen recording or CLI output that the harness itself captures from the
 * pushed commit, stored privately in ytimesy and shown on an in-app evidence
 * page that the pull request's "Evidence" section links to. The builder only
 * proposes how to show its change (a capture plan); everything shown is
 * produced by the harness-run capture, never by files the model made.
 */

export const EVIDENCE_LIMITS = {
	urls: 6,
	flowSteps: 20,
	stepTimeoutMs: 10_000,
	waitMs: 5_000,
	startSeconds: { default: 90, max: 180 },
	cliSeconds: 60,
	cliOutputChars: 6_000,
	screenshots: 8,
	screenshotBytes: 3 * 1024 * 1024,
	videoSeconds: 45,
	videoBytes: 8 * 1024 * 1024,
	/** `ytimesy-browser record`: the longest recording the agent can make. */
	agentVideoSeconds: 60,
	/** The whole capture in the workspace, tooling install included. */
	captureSeconds: 300,
	startCommandChars: 500,
} as const;

const localUrl = z
	.string()
	.max(2048)
	.refine((value) => {
		if (value.startsWith("/")) return !value.startsWith("//");
		try {
			const url = new URL(value);
			return (
				(url.protocol === "http:" || url.protocol === "https:") &&
				!url.username &&
				!url.password &&
				["localhost", "127.0.0.1", "0.0.0.0", "[::1]"].includes(url.hostname)
			);
		} catch {
			return false;
		}
	}, "Evidence pages are the app running in the workspace: a localhost URL or a path such as /settings.");

const selector = z.string().min(1).max(500);
export const evidenceFlowStep = z.discriminatedUnion("action", [
	z.object({ action: z.literal("goto"), url: localUrl }),
	z.object({ action: z.literal("click"), selector }),
	z.object({
		action: z.literal("fill"),
		selector,
		text: z.string().max(500),
	}),
	z.object({
		action: z.literal("press"),
		key: z.string().min(1).max(40),
		selector: selector.optional(),
	}),
	z.object({
		action: z.literal("wait"),
		ms: z.number().int().min(0).max(EVIDENCE_LIMITS.waitMs),
	}),
	z.object({ action: z.literal("waitFor"), selector }),
	z.object({
		action: z.literal("screenshot"),
		name: z
			.string()
			.regex(/^[a-z0-9][a-z0-9-]{0,30}$/)
			.optional(),
	}),
]);
export type EvidenceFlowStep = z.infer<typeof evidenceFlowStep>;

const command = z
	.string()
	.trim()
	.min(1)
	.max(EVIDENCE_LIMITS.startCommandChars)
	.refine((value) => !/[\r\n\0]/.test(value), "One line only.");

/** The builder's capture plan (`ytimesy-evidence capture`), saved in the workspace. */
export const evidenceRequest = z.discriminatedUnion("mode", [
	z.object({
		version: z.literal(1),
		mode: z.literal("web"),
		start: command,
		urls: z.array(localUrl).min(1).max(EVIDENCE_LIMITS.urls),
		flow: z.array(evidenceFlowStep).max(EVIDENCE_LIMITS.flowSteps).default([]),
		startSeconds: z
			.number()
			.int()
			.min(5)
			.max(EVIDENCE_LIMITS.startSeconds.max)
			.default(EVIDENCE_LIMITS.startSeconds.default),
	}),
	z.object({
		version: z.literal(1),
		mode: z.literal("cli"),
		command,
	}),
]);
export type EvidenceRequest = z.infer<typeof evidenceRequest>;

/** Without a plan, a UI change in a package with a dev script is started with it. */
export type EvidencePlan = EvidenceRequest | { version: 1; mode: "auto" };

export function evidenceRequestFromText(text: string | null) {
	if (!text?.trim()) return null;
	try {
		const parsed = evidenceRequest.safeParse(JSON.parse(text));
		return parsed.success ? parsed.data : null;
	} catch {
		return null;
	}
}

const VISIBLE_EXTENSIONS =
	/\.(tsx|jsx|vue|svelte|astro|html?|css|scss|sass|less|styl|mdx|svg|png|jpe?g|gif|webp|ico|woff2?|ttf|otf)$/i;
const VISIBLE_DIRECTORIES =
	/(^|\/)(components?|pages|app|routes|views|layouts|templates|public|static|styles|ui|features|screens|widgets)\//i;
const NOT_VISIBLE =
	/(^|\/)(__tests__|tests?|spec|e2e|fixtures|__snapshots__|stories|\.github|docs?)\/|\.(test|spec|stories)\.[a-z]+$|\.d\.ts$/i;

/** Whether a changed path can change what a user sees in the running app. */
export function visiblePath(path: string) {
	if (NOT_VISIBLE.test(path)) return false;
	if (VISIBLE_EXTENSIONS.test(path)) return true;
	return (
		VISIBLE_DIRECTORIES.test(path) && /\.(ts|js|mjs|cjs|json)$/i.test(path)
	);
}

export function visibleChanges(paths: readonly string[]) {
	return paths.filter(visiblePath);
}

/**
 * Whether this handoff captures evidence: an explicit plan always (the
 * builder asked for it), otherwise only a diff that touches visible files.
 */
export function evidencePlanFor(input: {
	request: EvidenceRequest | null;
	changedPaths: readonly string[];
}): EvidencePlan | null {
	if (input.request) return input.request;
	return visibleChanges(input.changedPaths).length
		? { version: 1, mode: "auto" }
		: null;
}

/** A short identity of the plan, so a re-push of the same commit with the same plan does not recapture. */
export function evidencePlanKey(plan: EvidencePlan, sha256Hex: string) {
	return `${plan.mode}-${sha256Hex.slice(0, 12)}`;
}

const sha = z.string().regex(/^[a-f0-9]{40}([a-f0-9]{24})?$/);
const fileName = z
	.string()
	.regex(/^[a-z0-9][a-z0-9-]{0,40}\.(png|webm|mp4|txt|json)$/);
const isoTime = z.string().max(40);

export const evidenceManifest = z.object({
	version: z.literal(1),
	mode: z.enum(["verify", "preview"]),
	kind: z.enum(["web", "cli"]),
	status: z.enum(["captured", "app-failed", "dirty", "tooling-failed"]),
	reason: z.string().max(600).default(""),
	sha: sha.or(z.literal("")),
	clean: z.boolean(),
	startCommand: z.string().max(EVIDENCE_LIMITS.startCommandChars).default(""),
	startSource: z.enum(["plan", "auto", "cli"]),
	urls: z.array(z.string().max(2048)).max(EVIDENCE_LIMITS.urls).default([]),
	pages: z
		.array(
			z.object({
				url: z.string().max(2048),
				status: z.number().int().nullable(),
				title: z.string().max(300).default(""),
				screenshot: fileName.nullable(),
				error: z.string().max(400).default(""),
			}),
		)
		.max(EVIDENCE_LIMITS.urls)
		.default([]),
	flow: z
		.array(
			z.object({
				step: z.string().max(600),
				ok: z.boolean(),
				error: z.string().max(400).default(""),
				screenshot: fileName.nullable().default(null),
			}),
		)
		.max(EVIDENCE_LIMITS.flowSteps)
		.default([]),
	video: z
		.object({ file: fileName, seconds: z.number().min(0) })
		.nullable()
		.default(null),
	cli: z
		.object({
			command: z.string().max(EVIDENCE_LIMITS.startCommandChars),
			exitCode: z.number().int().nullable(),
			file: fileName,
		})
		.nullable()
		.default(null),
	files: z
		.array(
			z.object({
				name: fileName,
				bytes: z.number().int().min(0),
				sha256: z.string().regex(/^[a-f0-9]{64}$/),
			}),
		)
		.max(EVIDENCE_LIMITS.screenshots + 3)
		.default([]),
	dropped: z.array(z.string().max(200)).max(20).default([]),
	/** Untracked inputs taken from the chat's checkout: dependency folders (linked) and .env files (copied). */
	linked: z.array(z.string().max(200)).max(40).default([]),
	browser: z.string().max(120).default(""),
	viewport: z.string().max(20).default(""),
	startedAt: isoTime,
	appReadyAt: isoTime.default(""),
	finishedAt: isoTime,
});
export type EvidenceManifest = z.infer<typeof evidenceManifest>;

/**
 * Where evidence lives: in ytimesy, never in the user's repository. Media is
 * kept in the private object store and served only to the signed-in owner of
 * the project; the pull request description carries a short summary and a
 * link to the evidence page.
 */
export const EVIDENCE_RETENTION_DAYS = 30;

/** Captures kept per pull request; older ones are removed when a new one is stored. */
export const EVIDENCE_KEPT_PER_PULL = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A file name the capture may produce; anything else is never stored or served. */
export function evidenceFileName(name: string) {
	return fileName.safeParse(name).success;
}

/** The in-app evidence page of one capture (signed-in project owner only). */
export function evidencePagePath(projectId: string, evidenceId: string) {
	if (!UUID.test(projectId) || !UUID.test(evidenceId))
		throw new Error("Invalid evidence page.");
	return `/projects/${projectId}/evidence/${evidenceId}`;
}

/** The authenticated media route of one stored file. */
export function evidenceMediaPath(
	projectId: string,
	evidenceId: string,
	name: string,
) {
	if (!evidenceFileName(name)) throw new Error("Invalid evidence file.");
	return `/api${evidencePagePath(projectId, evidenceId)}/${name}`;
}

/** The absolute page URL for the pull request, or null without a usable app origin. */
export function evidencePageUrl(
	appUrl: string | undefined,
	projectId: string,
	evidenceId: string,
) {
	if (!appUrl) return null;
	try {
		const url = new URL(appUrl);
		const local = ["localhost", "127.0.0.1"].includes(url.hostname);
		if (
			url.username ||
			url.password ||
			!(url.protocol === "https:" || (local && url.protocol === "http:"))
		)
			return null;
		return `${url.origin}${evidencePagePath(projectId, evidenceId)}`;
	} catch {
		return null;
	}
}

type EvidenceExtension = "png" | "webm" | "mp4" | "txt" | "json";
const EVIDENCE_CONTENT_TYPES: Record<EvidenceExtension, string> = {
	png: "image/png",
	webm: "video/webm",
	mp4: "video/mp4",
	txt: "text/plain; charset=utf-8",
	json: "application/json",
};

export function evidenceContentType(name: string) {
	const extension = name.split(".").pop() as EvidenceExtension;
	return EVIDENCE_CONTENT_TYPES[extension] ?? null;
}

/** Whether a stored file is a screen recording. */
export function evidenceVideoFile(name: string) {
	return name.endsWith(".webm") || name.endsWith(".mp4");
}

/** Bytes a manifest may name, by kind; anything above was dropped in the workspace or is refused. */
export function evidenceFileLimit(name: string) {
	if (evidenceVideoFile(name)) return EVIDENCE_LIMITS.videoBytes;
	if (name.endsWith(".png")) return EVIDENCE_LIMITS.screenshotBytes;
	return 256 * 1024;
}

/** Status of a stored capture: the manifest's, or capturing while the job runs. */
export type EvidenceStatus = EvidenceManifest["status"] | "capturing";

/** "3 screenshots, 6 s recording" (or the CLI equivalent) for a manifest's stored files. */
export function evidenceMediaSummary(input: {
	files: readonly { name: string }[];
	videoSeconds: number | null;
	kind: EvidenceManifest["kind"];
}) {
	const shots = input.files.filter((file) => file.name.endsWith(".png")).length;
	const parts = [
		shots ? `${shots} screenshot${shots === 1 ? "" : "s"}` : "",
		input.videoSeconds !== null &&
		input.files.some((file) => evidenceVideoFile(file.name))
			? `${Math.max(1, Math.round(input.videoSeconds))} s screen recording`
			: "",
		input.kind === "cli" &&
		input.files.some((file) => file.name === "output.txt")
			? "CLI output"
			: "",
	].filter(Boolean);
	return parts.join(", ");
}

export const EVIDENCE_START = "<!-- ytimesy-evidence:start";
export const EVIDENCE_END = "<!-- ytimesy-evidence:end -->";

/** What the current section says it shows, to skip recapturing an unchanged commit and plan. */
export function evidenceSectionState(body: string | null | undefined) {
	const match =
		/<!-- ytimesy-evidence:start sha=([a-f0-9]{0,64}) plan=([a-z0-9-]{0,40}) -->/.exec(
			body ?? "",
		);
	return match ? { sha: match[1], plan: match[2] } : null;
}

/** Replaces the evidence section, or adds one before the footer; the rest of the description is kept. */
export function withEvidenceSection(
	body: string | null | undefined,
	section: string,
) {
	const current = body ?? "";
	const start = current.indexOf(EVIDENCE_START);
	const end = current.indexOf(EVIDENCE_END, start);
	return normalizedEvidenceSections(
		start >= 0 && end > start
			? `${current.slice(0, start)}${section}${current.slice(end + EVIDENCE_END.length)}`
			: insertBeforePullRequestFooter(current, section),
	);
}

function plain(text: string, max = 300) {
	return text
		.replace(/[\r\n]+/g, " ")
		.replace(/[<>[\]()*_`|\\]/g, (character) => `\\${character}`)
		.slice(0, max);
}

/** Whether the capture is of a clean checkout of exactly the pull request head. */
export function evidenceVerifiedAtHead(
	manifest: Pick<EvidenceManifest, "status" | "clean" | "sha">,
	headSha: string | null,
) {
	return (
		manifest.status === "captured" && manifest.clean && manifest.sha === headSha
	);
}

export type RenderedEvidence = {
	manifest: EvidenceManifest;
	planKey: string;
	/** The pull request head the commit was checked against. */
	headSha: string;
	/** The in-app evidence page, or null when no page could be stored. */
	pageUrl: string | null;
};

const FAILURE_LEAD: Record<
	Exclude<EvidenceManifest["status"], "captured">,
	string
> = {
	"app-failed": "The app did not start",
	dirty: "The workspace checkout did not match the pushed commit",
	"tooling-failed": "The capture tooling could not run",
};

/**
 * The pull request's Evidence section: a short summary of what was verified
 * and a link to the evidence page in ytimesy. No media is embedded and
 * nothing is stored in the repository.
 */
export function renderEvidenceSection(input: RenderedEvidence) {
	const { manifest } = input;
	const short = manifest.sha.slice(0, 7) || "unknown";
	const lines = [
		`${EVIDENCE_START} sha=${manifest.sha} plan=${input.planKey} -->`,
		"## Evidence",
		"",
	];
	if (manifest.status !== "captured") {
		lines.push(
			`${FAILURE_LEAD[manifest.status]} at commit \`${short}\`, so there are no screenshots or recording for it${manifest.reason ? `: ${plain(manifest.reason, 400)}` : "."}`,
		);
	} else {
		const where = evidenceVerifiedAtHead(manifest, input.headSha)
			? `a clean checkout of \`${short}\`, the pull request head`
			: `commit \`${short}\``;
		const media = evidenceMediaSummary({
			files: manifest.files,
			videoSeconds: manifest.video?.seconds ?? null,
			kind: manifest.kind,
		});
		const failed = manifest.flow.filter((step) => !step.ok).length;
		lines.push(
			`Verified by the ytimesy harness from ${where}: ${media || "no media captured"}${failed ? ` (${failed} flow step${failed === 1 ? "" : "s"} failed)` : ""}.`,
		);
	}
	lines.push(
		"",
		input.pageUrl
			? `[View the evidence](${input.pageUrl}) in ytimesy (sign-in required). It is kept for ${EVIDENCE_RETENTION_DAYS} days or until this pull request closes.`
			: "The evidence page is unavailable.",
		EVIDENCE_END,
	);
	return lines.join("\n");
}

/**
 * Who made a capture: the harness, from a pull request's pushed commit, or
 * the agent itself with `ytimesy-browser screenshot|record` during a turn.
 */
export type EvidenceSource = "harness" | "agent";

/** One stored capture as the app shows it (evidence page and chat card). */
export type EvidenceRecord = {
	readonly id: string;
	readonly projectId: string;
	readonly sessionId: string | null;
	readonly source: EvidenceSource;
	/** The chat item (tool call) an agent capture was made in, when known. */
	readonly itemId: string | null;
	/** Pull request and commit: empty ("" and 0) for agent captures, which belong to the chat. */
	readonly fullName: string;
	readonly pullNumber: number;
	readonly commitSha: string;
	readonly headSha: string | null;
	readonly kind: EvidenceManifest["kind"];
	readonly status: EvidenceStatus;
	readonly reason: string;
	readonly startCommand: string;
	readonly urls: readonly string[];
	readonly files: readonly {
		readonly name: string;
		readonly bytes: number;
		readonly sha256: string;
	}[];
	readonly manifest: EvidenceManifest | null;
	readonly browser: string;
	readonly videoSeconds: number | null;
	readonly captureStartedAt: string | null;
	readonly captureFinishedAt: string | null;
	readonly createdAt: string;
	readonly expiresAt: string;
};

export const CAPTURES_START = "<!-- ytimesy-captures:start -->";
export const CAPTURES_END = "<!-- ytimesy-captures:end -->";

/** "1 screenshot, 1 recording (5 s)" for a chat's agent captures. */
export function agentCapturesSummary(
	captures: readonly {
		readonly files: readonly { readonly name: string }[];
		readonly videoSeconds: number | null;
	}[],
) {
	let shots = 0;
	const recordings: number[] = [];
	for (const capture of captures)
		for (const file of capture.files)
			if (evidenceVideoFile(file.name))
				recordings.push(Math.max(1, Math.round(capture.videoSeconds ?? 0)));
			else if (file.name.endsWith(".png")) shots++;
	return [
		shots ? `${shots} screenshot${shots === 1 ? "" : "s"}` : "",
		recordings.length
			? `${recordings.length} recording${recordings.length === 1 ? "" : "s"} (${recordings.map((seconds) => `${seconds} s`).join(", ")})`
			: "",
	]
		.filter(Boolean)
		.join(", ");
}

const EVIDENCE_HEADING = "## Evidence";

/**
 * The pull request's Evidence section for the agent's own screenshots and
 * recordings (`ytimesy-browser screenshot|record`): a count and a link to the
 * evidence page in ytimesy, like the harness section. No media is embedded
 * and nothing is stored in the repository. Next to a harness Evidence
 * section it drops its own heading (normalizedEvidenceSections).
 */
export function renderAgentCapturesSection(input: {
	summary: string;
	pageUrl: string | null;
}) {
	if (!input.summary) return null;
	return [
		CAPTURES_START,
		EVIDENCE_HEADING,
		"",
		`Captured by the agent on its desktop: ${input.summary}.`,
		"",
		input.pageUrl
			? `[View the evidence](${input.pageUrl}) in ytimesy (sign-in required). It is kept for ${EVIDENCE_RETENTION_DAYS} days.`
			: "The evidence page is unavailable.",
		CAPTURES_END,
	].join("\n");
}

function sectionBetween(body: string, start: string, end: string) {
	const from = body.indexOf(start);
	const to = body.indexOf(end, from);
	if (from < 0 || to < 0) return null;
	return body.slice(from, to + end.length);
}

/** The captures section of a description, or null when it has none. */
export function agentCapturesSection(body: string | null | undefined) {
	return sectionBetween(body ?? "", CAPTURES_START, CAPTURES_END);
}

function withoutSection(body: string, section: string) {
	const at = body.indexOf(section);
	return [
		body.slice(0, at).trimEnd(),
		body.slice(at + section.length).trimStart(),
	]
		.filter(Boolean)
		.join("\n\n");
}

/**
 * One Evidence heading: with a harness Evidence section, the captures
 * section follows it without its own heading; alone, it has the heading.
 */
export function normalizedEvidenceSections(body: string) {
	const captures = agentCapturesSection(body);
	if (!captures) return body;
	const harness = sectionBetween(body, EVIDENCE_START, EVIDENCE_END);
	const rest = withoutSection(body, captures);
	const inner = captures
		.slice(CAPTURES_START.length, -CAPTURES_END.length)
		.trim()
		.replace(/^## Evidence\s*/, "");
	if (!harness)
		return insertBeforePullRequestFooter(
			rest,
			`${CAPTURES_START}\n${EVIDENCE_HEADING}\n\n${inner}\n${CAPTURES_END}`,
		);
	const end = rest.indexOf(EVIDENCE_END) + EVIDENCE_END.length;
	return `${rest.slice(0, end)}\n${CAPTURES_START}\n${inner}\n${CAPTURES_END}${rest.slice(end)}`;
}

/** Replaces the captures section (null removes it), or adds one before the footer. */
export function withAgentCapturesSection(
	body: string | null | undefined,
	section: string | null,
) {
	const current = body ?? "";
	const existing = agentCapturesSection(current);
	const rest = existing ? withoutSection(current, existing) : current;
	return section
		? normalizedEvidenceSections(insertBeforePullRequestFooter(rest, section))
		: rest;
}

/** What the evidence page says a capture belongs to; null fields are unknown. */
export type EvidenceContext = {
	readonly chatTitle: string | null;
	readonly chatPath: string | null;
	readonly pullRequest: {
		readonly fullName: string;
		readonly number: number;
		readonly url: string;
	} | null;
	readonly branch: string | null;
	/** Short commit sha; harness captures only. */
	readonly commit: string | null;
	readonly capturedAt: string;
};

const GITHUB_FULL_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

/**
 * Combines a capture with its chat and pull request link. A harness capture
 * names its own pull request; an agent capture takes its chat's.
 */
export function evidenceContext(
	evidence: EvidenceRecord,
	found: {
		chatTitle: string | null;
		chatBranch: string | null;
		link: {
			fullName: string;
			pullNumber: number;
			headRef: string | null;
		} | null;
	},
): EvidenceContext {
	const fullName = evidence.fullName || found.link?.fullName || "";
	const number = evidence.pullNumber || found.link?.pullNumber || 0;
	const pullRequest =
		GITHUB_FULL_NAME.test(fullName) && number > 0
			? {
					fullName,
					number,
					url: `https://github.com/${fullName}/pull/${number}`,
				}
			: null;
	const title = found.chatTitle?.trim();
	return {
		chatTitle: title && title !== "New session" ? title : null,
		chatPath:
			evidence.sessionId && found.chatTitle !== null
				? `/?project=${evidence.projectId}&chat=${evidence.sessionId}`
				: null,
		pullRequest,
		branch: found.link?.headRef || found.chatBranch || null,
		commit: evidence.commitSha ? evidence.commitSha.slice(0, 7) : null,
		capturedAt: evidence.captureStartedAt ?? evidence.createdAt,
	};
}

/** "just now", "5 min ago", "2 h ago", "3 days ago"; "" for a bad date. */
export function evidenceAge(at: string, nowMs: number) {
	const then = Date.parse(at);
	if (!Number.isFinite(then)) return "";
	const minutes = Math.floor(Math.max(0, nowMs - then) / 60_000);
	if (minutes < 1) return "just now";
	if (minutes < 60) return `${minutes} min ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours} h ago`;
	const days = Math.floor(hours / 24);
	return `${days} day${days === 1 ? "" : "s"} ago`;
}
