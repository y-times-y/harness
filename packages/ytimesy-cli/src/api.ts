/**
 * The ytimesy import API (/api/local-import/*), as the CLI calls it. Shapes
 * mirror src/domain/local-import.ts and src/server/services/local-import.ts.
 */
import type { LocalAgent } from "./local-agents.ts";

export type PlanProject = {
	readonly id: string;
	readonly name: string;
	readonly repositories: readonly string[];
};

export type StartResponse = {
	readonly token: string;
	readonly expiresAt: string;
	readonly appUrl: string;
	readonly projects: readonly PlanProject[];
};

export type PlanGroupRequest = {
	readonly folder: string;
	readonly git: {
		readonly repository: string | null;
		readonly host: string | null;
		readonly branch: string | null;
	} | null;
	readonly sessions: number;
	readonly bytes: number;
	readonly tools: readonly LocalAgent[];
	readonly latestAt?: string;
};

export type PlanEntry = {
	readonly folder: string;
	readonly sessions: number;
} & (
	| {
			readonly action: "import";
			/** Null: no project holds the repository yet; create-project makes one. */
			readonly projectId: string | null;
			readonly projectName: string;
			readonly newProject: boolean;
			readonly repository: string;
			readonly visibility: "public" | "private" | "unknown";
	  }
	| {
			readonly action: "grant-access";
			readonly repository: string;
			readonly connectUrl: string;
	  }
	| {
			readonly action: "no-repository";
			readonly reason: "no-git" | "no-remote" | "other-host";
			readonly suggestedName: string;
			readonly attachTo: readonly { id: string; name: string }[];
	  }
);

export type CreateProjectResponse = {
	readonly projectId: string;
	readonly repository: string;
	readonly defaultBranch: string;
	readonly cloneUrl: string;
	readonly sshUrl: string;
};

export type SessionUploadResponse = {
	readonly importedSessionId: string;
	readonly transcriptUpload: string;
};

export type FinishResponse = {
	readonly projectId: string;
	readonly sessionId: string;
	readonly openUrl: string;
	readonly handoffDirectory?: string;
};

export class ApiError extends Error {
	constructor(
		message: string,
		readonly status: number,
		readonly path: string,
	) {
		super(message);
	}
}

const TIMEOUT_MS = 120_000;

/** The server's message: a plain-text body, or `{ error }`. */
async function errorMessage(response: Response) {
	const text = (await response.text().catch(() => "")).trim();
	try {
		const json = JSON.parse(text) as { error?: unknown };
		if (typeof json.error === "string") return json.error;
	} catch {
		// plain text
	}
	return text.slice(0, 500) || `HTTP ${response.status}`;
}

export class ImportApi {
	constructor(
		readonly base: string,
		private token: string | null = null,
		private readonly userAgent = "ytimesy-cli",
	) {}

	setToken(token: string) {
		this.token = token;
	}

	private async request<T>(
		path: string,
		init: { method: string; body?: BodyInit; contentType?: string },
	): Promise<T> {
		const url = new URL(path, this.base).toString();
		let response: Response;
		try {
			response = await fetch(url, {
				method: init.method,
				body: init.body,
				headers: {
					"user-agent": this.userAgent,
					...(init.contentType ? { "content-type": init.contentType } : {}),
					...(this.token ? { authorization: `Bearer ${this.token}` } : {}),
				},
				signal: AbortSignal.timeout(TIMEOUT_MS),
			});
		} catch (error) {
			throw new ApiError(
				`Could not reach ${new URL(this.base).host}: ${(error as Error).message}`,
				0,
				path,
			);
		}
		if (!response.ok)
			throw new ApiError(await errorMessage(response), response.status, path);
		return (await response.json()) as T;
	}

	private json<T>(path: string, body: unknown) {
		return this.request<T>(path, {
			method: "POST",
			body: JSON.stringify(body),
			contentType: "application/json",
		});
	}

	start(body: { code: string; agent?: LocalAgent; cliVersion?: string }) {
		return this.json<StartResponse>("/api/local-import/start", body);
	}

	plan(groups: readonly PlanGroupRequest[]) {
		return this.json<{ groups: PlanEntry[] }>("/api/local-import/plan", {
			groups,
		});
	}

	/** A project for a repository the ytimesy app reaches (409: it cannot see it yet). */
	createProject(body: { folder: string; repository: string }) {
		return this.json<CreateProjectResponse>(
			"/api/local-import/create-project",
			body,
		);
	}

	secrets(body: {
		projectId: string;
		variables: readonly {
			name: string;
			value: string;
			source: ".env" | ".env.local";
		}[];
	}) {
		return this.json<unknown>("/api/local-import/secrets", body);
	}

	session(body: { projectId: string; handoff: unknown; total?: number }) {
		return this.json<SessionUploadResponse>("/api/local-import/sessions", body);
	}

	transcript(uploadPath: string, archive: Uint8Array) {
		return this.request<{ stored: number }>(uploadPath, {
			method: "PUT",
			body: new Blob([new Uint8Array(archive)]),
			contentType: "application/gzip",
		});
	}

	finish(body: {
		projectId: string;
		continue: { tool: LocalAgent; sessionId: string };
		branch: string;
		repository?: string;
		pushedFiles: number;
		skippedFiles: number;
		pushedPaths: readonly string[];
		skippedPaths: readonly string[];
	}) {
		return this.json<FinishResponse>("/api/local-import/finish", body);
	}

	cancel() {
		return this.json<{ status: string }>("/api/local-import/cancel", {});
	}
}
