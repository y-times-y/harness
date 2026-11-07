/**
 * A local stand-in for ytimesy's /api/local-import/* routes, for the CLI's
 * integration test: request bodies are checked with the app's own schemas,
 * the plan comes from the app's own planLocalImport, and finish checks the
 * pushed branch in a local bare repository.
 */
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { gunzipSync } from "node:zlib";
import type { z } from "zod";
import {
	createProjectRequest,
	finishRequest,
	type HandoffDocument,
	handoffBranch,
	normalizeImportCode,
	planLocalImport,
	planRequest,
	secretsRequest,
	sessionUploadRequest,
	startRequest,
} from "./import-protocol.ts";

export type FakeProject = { id: string; name: string; repositories: string[] };

export type FakeServerOptions = {
	readonly code: string;
	readonly projects: FakeProject[];
	/** `owner/name` → private (true) or public (false), as the GitHub app sees it. */
	readonly reachable: Map<string, boolean>;
	/** `owner/name` → local bare repository the CLI's pushes land in. */
	readonly remotes: Map<string, string>;
	readonly owner: string;
	/**
	 * Repositories the app cannot see until the test says so (an install on
	 * selected repositories); every other one with a remote it sees at once.
	 */
	readonly hidden?: Set<string>;
	/** Answer the nth call of a route with this status instead. */
	readonly failures?: { route: string; call: number; status: number }[];
};

export type FakeCall = { method: string; route: string; body: unknown };

export type FakeServer = {
	readonly url: string;
	readonly calls: FakeCall[];
	/** The user's projects (create-project adds to them). */
	readonly projects: FakeProject[];
	/** Repositories the app cannot see yet; delete one to "add" it to the install. */
	readonly hidden: Set<string>;
	readonly sessions: Map<
		string,
		{ projectId: string; handoff: HandoffDocument; transcript?: Buffer }
	>;
	readonly secrets: { projectId: string; names: string[] }[];
	/** Answers the nth call of a route (counted from the start) with this status. */
	fail(route: string, call: number, status: number): void;
	/** Whether the import was cancelled. */
	cancelled(): boolean;
	close(): Promise<void>;
};

const TOKEN = `ytmi_${"t".repeat(43)}`;

async function body(request: http.IncomingMessage) {
	const chunks: Buffer[] = [];
	for await (const chunk of request) chunks.push(chunk as Buffer);
	return Buffer.concat(chunks);
}

function parse<Schema extends z.ZodType>(
	schema: Schema,
	raw: Buffer,
): z.infer<Schema> {
	const result = schema.safeParse(JSON.parse(raw.toString("utf8")));
	if (!result.success)
		throw Object.assign(
			new Error(
				`Invalid request: ${result.error.issues
					.slice(0, 5)
					.map((issue) => `${issue.path.join(".")}: ${issue.message}`)
					.join("; ")}`,
			),
			{ status: 400 },
		);
	return result.data;
}

export async function startFakeServer(
	options: FakeServerOptions,
): Promise<FakeServer> {
	const calls: FakeCall[] = [];
	const sessions: FakeServer["sessions"] = new Map();
	const secrets: FakeServer["secrets"] = [];
	const projects = options.projects;
	const hidden = options.hidden ?? new Set<string>();
	let codeUsed = false;
	let cancelled = false;
	const failures = [...(options.failures ?? [])];
	let finished: { projectId: string; sessionId: string } | null = null;
	let url = "";

	const handle = async (
		request: http.IncomingMessage,
		raw: Buffer,
	): Promise<unknown> => {
		const parsed = new URL(request.url ?? "/", url);
		const route = parsed.pathname.replace("/api/local-import/", "");
		if (route !== "start") {
			if (request.headers.authorization !== `Bearer ${TOKEN}`)
				throw Object.assign(new Error("This import token is not valid."), {
					status: 401,
				});
			if (finished && route !== "finish")
				throw Object.assign(new Error("This import already finished."), {
					status: 401,
				});
			if (cancelled)
				throw Object.assign(
					new Error("Import cancelled. Copy a new prompt in ytimesy."),
					{ status: 401 },
				);
		}
		switch (`${request.method} ${route}`) {
			case "POST start": {
				const input = parse(startRequest, raw);
				if (normalizeImportCode(input.code) !== options.code || codeUsed)
					throw Object.assign(
						new Error(
							"This code was already used. Copy a new prompt in ytimesy.",
						),
						{ status: 410 },
					);
				codeUsed = true;
				return {
					token: TOKEN,
					expiresAt: new Date(Date.now() + 7_200_000).toISOString(),
					appUrl: url,
					projects,
				};
			}
			case "POST cancel": {
				cancelled = true;
				return { status: "failed" };
			}
			case "POST plan": {
				const input = parse(planRequest, raw);
				return {
					groups: planLocalImport({
						groups: input.groups,
						projects,
						reachable: options.reachable,
						installationUrl:
							"https://github.com/apps/ytimesy/installations/new",
					}),
				};
			}
			case "POST create-project": {
				// Like the app: a project for a repository it can see, never a new repository.
				const input = parse(createProjectRequest, raw);
				const repository = input.repository.toLowerCase();
				const sees =
					!hidden.has(repository) &&
					(options.reachable.has(repository) ||
						options.remotes.has(repository));
				if (!sees)
					throw Object.assign(
						new Error(
							`The ytimesy GitHub app cannot see ${input.repository} yet. Add it to the app's repositories at https://github.com/apps/ytimesy/installations/new, then re-run.`,
						),
						{ status: 409 },
					);
				const existing = projects.find((project) =>
					project.repositories.includes(repository),
				);
				const project = existing ?? {
					id: randomUUID(),
					name: repository.split("/")[1] ?? repository,
					repositories: [repository],
				};
				if (!existing) projects.push(project);
				if (!options.reachable.has(repository))
					options.reachable.set(repository, true);
				return {
					projectId: project.id,
					repository,
					defaultBranch: "main",
					cloneUrl: `https://github.com/${repository}.git`,
					sshUrl: `git@github.com:${repository}.git`,
				};
			}
			case "POST secrets": {
				const input = parse(secretsRequest, raw);
				secrets.push({
					projectId: input.projectId,
					names: input.variables.map((variable) => variable.name),
				});
				return { saved: input.variables.length };
			}
			case "POST sessions": {
				if (raw.byteLength > 2 * 1024 * 1024)
					throw Object.assign(new Error("Too large"), { status: 413 });
				const input = parse(sessionUploadRequest, raw);
				if (!projects.some((project) => project.id === input.projectId))
					throw Object.assign(new Error("Project is not available."), {
						status: 404,
					});
				const existing = [...sessions].find(
					([, session]) =>
						session.projectId === input.projectId &&
						session.handoff.tool === input.handoff.tool &&
						session.handoff.sessionId === input.handoff.sessionId,
				);
				const id = existing?.[0] ?? randomUUID();
				sessions.set(id, {
					projectId: input.projectId,
					handoff: input.handoff,
				});
				return {
					importedSessionId: id,
					transcriptUpload: `/api/local-import/transcript?session=${id}`,
				};
			}
			case "PUT transcript": {
				const id = parsed.searchParams.get("session") ?? "";
				const session = sessions.get(id);
				if (!session)
					throw Object.assign(
						new Error("Upload this session's handoff first."),
						{
							status: 404,
						},
					);
				if (raw[0] !== 0x1f || raw[1] !== 0x8b)
					throw Object.assign(new Error("Send gzip."), { status: 415 });
				gunzipSync(raw);
				session.transcript = raw;
				return { stored: raw.byteLength };
			}
			case "POST finish": {
				const input = parse(finishRequest, raw);
				if (finished) return { ...finished, openUrl: openUrl(finished) };
				const project = projects.find((item) => item.id === input.projectId);
				if (!project)
					throw Object.assign(new Error("Project is not available."), {
						status: 404,
					});
				const branch = handoffBranch(input.branch);
				const repository =
					project.repositories.length === 1
						? project.repositories[0]
						: input.repository;
				const remote = repository ? options.remotes.get(repository) : undefined;
				if (!branch || !remote)
					throw Object.assign(new Error("Bad branch or repository."), {
						status: 400,
					});
				const exists = execFileSync(
					"git",
					["ls-remote", "--heads", remote, `refs/heads/${branch}`],
					{ encoding: "utf8" },
				).trim();
				if (!exists)
					throw Object.assign(new Error(`Push ${branch} first.`), {
						status: 409,
					});
				const uploaded = [...sessions.values()].some(
					(session) =>
						session.projectId === project.id &&
						session.handoff.tool === input.continue.tool &&
						session.handoff.sessionId === input.continue.sessionId,
				);
				if (!uploaded)
					throw Object.assign(
						new Error("Upload the session to continue first."),
						{
							status: 409,
						},
					);
				finished = { projectId: project.id, sessionId: randomUUID() };
				return {
					...finished,
					openUrl: openUrl(finished),
					handoffDirectory: "~/.ytimesy/handoff",
				};
			}
			default:
				throw Object.assign(new Error("Not found"), { status: 404 });
		}
	};

	const openUrl = (chat: { projectId: string; sessionId: string }) =>
		`${url}/?project=${chat.projectId}&chat=${chat.sessionId}`;

	const server = http.createServer(async (request, response) => {
		const raw = await body(request);
		const route = new URL(request.url ?? "/", "http://x").pathname.replace(
			"/api/local-import/",
			"",
		);
		const isJson =
			request.headers["content-type"]?.startsWith("application/json");
		calls.push({
			method: request.method ?? "",
			route,
			body: isJson
				? JSON.parse(raw.toString("utf8") || "null")
				: raw.byteLength,
		});
		const nth = calls.filter((call) => call.route === route).length;
		const failure = failures.find(
			(item) => item.route === route && item.call === nth,
		);
		try {
			if (failure)
				throw Object.assign(new Error("Injected failure"), {
					status: failure.status,
				});
			const result = await handle(request, raw);
			response.writeHead(200, { "content-type": "application/json" });
			response.end(JSON.stringify(result));
		} catch (error) {
			const status = (error as { status?: number }).status ?? 500;
			response.writeHead(status, { "content-type": "text/plain" });
			response.end((error as Error).message);
		}
	});
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	return {
		url,
		calls,
		projects,
		hidden,
		sessions,
		secrets,
		fail: (route, call, status) => {
			failures.push({ route, call, status });
		},
		cancelled: () => cancelled,
		close: () =>
			new Promise((resolve) => {
				server.closeAllConnections();
				server.close(() => resolve());
			}),
	};
}
