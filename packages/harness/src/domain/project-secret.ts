import { posixShellQuoted } from "./posix-command";
import { isReaderRole, type SubagentRole } from "./subagent";

/**
 * Where a task VM keeps the project's environment variables and runtime
 * secrets. One fixed path, because agent commands, services and commits run
 * through execs whose $HOME can differ. The directory is private (0700).
 */
export const AGENT_SECRETS_DIRECTORY = "/tmp/ytimesy-secrets";
export const AGENT_SECRETS_ENV_PATH = `${AGENT_SECRETS_DIRECTORY}/agent.env`;

/**
 * Whether a session's workspace gets the project's env file and is told the
 * secret names. Read-only subagents (researcher, reviewer, checker) only
 * read and review, so they never receive secrets: their commands run as the
 * reader Linux user, which cannot read the 0700 secrets directory nor write
 * the env file. They still redact the values from their output.
 */
export function sessionReceivesProjectSecrets(session: {
	readonly agentRole?: SubagentRole | null;
}) {
	return !isReaderRole(session.agentRole);
}

/** Thrown when the env file's private directory cannot be prepared on the VM. */
export const PROJECT_SECRETS_PREPARATION_FAILED =
	"Could not prepare project secrets in the workspace.";

/** Shell that loads the project's variables when present. */
export const SOURCE_AGENT_SECRETS = `if [ -r ${AGENT_SECRETS_ENV_PATH} ]; then . ${AGENT_SECRETS_ENV_PATH}; fi`;

/**
 * Shell run before any VM snapshot: deletes the env file and proves it is gone,
 * so plaintext values never land in a reusable or retained image. The next turn
 * writes the file again.
 */
export const SCRUB_AGENT_SECRETS = `rm -rf ${AGENT_SECRETS_DIRECTORY} && test ! -e ${AGENT_SECRETS_DIRECTORY}`;

/** Holds the names of the runtime secrets in the env file, for the commit guard. */
const REDACTED_NAMES_VARIABLE = "YTIMESY_REDACTED_SECRETS";

export const PROJECT_SECRET_KINDS = [
	"environment",
	"runtime",
	"build",
] as const;
export type ProjectSecretKind = (typeof PROJECT_SECRET_KINDS)[number];

/** Runtime secrets are matched by value; very short values would redact ordinary text. */
const MIN_RUNTIME_SECRET_LENGTH = 6;

export const REDACTED = "[REDACTED]";

const RESERVED_SECRET_NAMES = new Set([
	"PATH",
	"HOME",
	"DISPLAY",
	"USER",
	"SHELL",
	"PWD",
	"OLDPWD",
	"TERM",
	REDACTED_NAMES_VARIABLE,
]);

export type PublicProjectSecret = {
	readonly id: string;
	readonly name: string;
	readonly kind: ProjectSecretKind;
	readonly hint: string;
	readonly updatedAt: string;
	/** Imported from a local .env and not yet reviewed (saved again or removed). */
	readonly imported?: true;
};

export function parseProjectSecretKind(value: unknown): ProjectSecretKind {
	const kind = PROJECT_SECRET_KINDS.find((candidate) => candidate === value);
	if (!kind) throw new Error("Choose a secret type.");
	return kind;
}

export function parseProjectSecretName(value: string) {
	const name = value.trim();
	if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(name)) {
		throw new Error(
			"Secret names must be uppercase letters, digits, and underscores.",
		);
	}
	if (RESERVED_SECRET_NAMES.has(name)) {
		throw new Error(`${name} is reserved and cannot be a project secret.`);
	}
	return name;
}

export function parseProjectSecretValue(
	value: string,
	kind: ProjectSecretKind = "environment",
) {
	const secret = value.trim();
	if (secret.length < 1) {
		throw new Error("A secret value is required.");
	}
	if (kind === "runtime" && secret.length < MIN_RUNTIME_SECRET_LENGTH) {
		throw new Error(
			`Runtime secrets must be at least ${MIN_RUNTIME_SECRET_LENGTH} characters so they can be redacted; use an environment variable for shorter values.`,
		);
	}
	if (secret.length > 8_192) {
		throw new Error("Secret values must be 8192 characters or fewer.");
	}
	return secret;
}

/** The VM env file: environment variables and runtime secrets, never build secrets. */
export function agentSecretsEnvFile(
	secrets: readonly {
		readonly name: string;
		readonly value: string;
		readonly kind: ProjectSecretKind;
	}[],
) {
	const exposed = secrets.filter((secret) => secret.kind !== "build");
	if (exposed.length === 0) return "# No project secrets configured.\n";
	const redacted = exposed
		.filter((secret) => secret.kind === "runtime")
		.map((secret) => secret.name);
	return `${[
		...exposed.map(
			(secret) => `export ${secret.name}=${posixShellQuoted(secret.value)}`,
		),
		`${REDACTED_NAMES_VARIABLE}=${posixShellQuoted(redacted.join(" "))}`,
	].join("\n")}\n`;
}

export type AgentSecretName = {
	readonly name: string;
	readonly kind: ProjectSecretKind;
};

/**
 * Tells the agent which project secrets exist and how each reaches it, by name
 * only, so it uses the variable instead of guessing or printing the environment.
 */
export function projectSecretsInstructions(
	secrets: readonly AgentSecretName[],
) {
	if (!secrets.length) return "";
	const listed = (kind: ProjectSecretKind) =>
		secrets
			.filter((secret) => secret.kind === kind)
			.map((secret) => secret.name)
			.join(", ");
	const lines = [
		listed("runtime") &&
			`Runtime secrets (their values are replaced with ${REDACTED} in tool output, and commits containing them are refused): ${listed("runtime")}.`,
		listed("environment") && `Environment variables: ${listed("environment")}.`,
		listed("build") &&
			`Build secrets (environment setup only, not set for you): ${listed("build")}.`,
	].filter(Boolean);
	return `Project secrets are set in every command's environment. ${lines.join(" ")} Reference them by name (for example "$NAME"); never print, echo or write their values to files, and never display them on screen: screenshots are not redacted.`;
}

/**
 * Shell run after `git add -A` in a repository: refuses when the staged
 * changes, or any commit not yet on a remote (content or message), contain a
 * runtime secret's value. Unstages first so nothing is committed.
 */
export const SECRET_COMMIT_GUARD = `if [ -r ${AGENT_SECRETS_ENV_PATH} ]; then ( . ${AGENT_SECRETS_ENV_PATH}; for name in $${REDACTED_NAMES_VARIABLE}; do value="\${!name}"; if [ -n "$value" ] && { git diff --cached; git log -p --format=%B --all --not --remotes; } | grep -qF -- "$value"; then git reset -q; echo "Refusing to commit: the changes or an unpushed commit contain the value of runtime secret $name. Remove it and use the environment variable instead." >&2; exit 3; fi; done ); fi`;

/** Encoded variants are matched only for values at least this long, to avoid false positives. */
const MIN_ENCODED_SECRET_LENGTH = 8;

const base64 = (bytes: Uint8Array) => {
	let binary = "";
	for (const byte of bytes) binary += String.fromCharCode(byte);
	return btoa(binary);
};

/**
 * The forms a value commonly takes in command output: as written, JSON-escaped,
 * URL-encoded, hex, and base64 or base64url. Base64 inside a larger encoded blob
 * depends on the value's byte offset, so the stable middle of each of the three
 * alignments is matched as well.
 */
export function secretForms(secret: string): string[] {
	const forms = new Set([secret]);
	if (secret.length >= MIN_ENCODED_SECRET_LENGTH) {
		const bytes = new TextEncoder().encode(secret);
		forms.add(JSON.stringify(secret).slice(1, -1));
		forms.add(encodeURIComponent(secret));
		const hex = Array.from(bytes, (byte) =>
			byte.toString(16).padStart(2, "0"),
		).join("");
		forms.add(hex);
		forms.add(hex.toUpperCase());
		const padded = base64(bytes);
		const encoded = [padded, padded.replace(/=+$/, "")];
		for (const offset of [0, 1, 2]) {
			const shifted = base64(
				new Uint8Array([...new Uint8Array(offset), ...bytes]),
			);
			// Drop the first group (mixed with preceding bytes) and the last partial one.
			const start = offset ? 4 : 0;
			const end =
				start + Math.floor((bytes.length - (offset ? 3 - offset : 0)) / 3) * 4;
			const middle = shifted.slice(start, end);
			if (middle.length >= MIN_ENCODED_SECRET_LENGTH) encoded.push(middle);
		}
		for (const form of encoded) {
			forms.add(form);
			forms.add(form.replaceAll("+", "-").replaceAll("/", "_"));
		}
	}
	return [...forms].filter((form) => form.length >= MIN_RUNTIME_SECRET_LENGTH);
}

/** Replaces every runtime secret value, and its common encodings, in strings anywhere inside `value`. */
export function redactSecretValues<T>(value: T, secrets: readonly string[]): T {
	const usable = secrets
		.filter((secret) => secret.length >= MIN_RUNTIME_SECRET_LENGTH)
		.flatMap(secretForms)
		.sort((a, b) => b.length - a.length);
	if (!usable.length) return value;
	const visit = (item: unknown): unknown => {
		if (typeof item === "string")
			return usable.reduce(
				(text, secret) => text.split(secret).join(REDACTED),
				item,
			);
		if (Array.isArray(item)) return item.map(visit);
		if (item && typeof item === "object" && item.constructor === Object)
			return Object.fromEntries(
				Object.entries(item).map(([key, entry]) => [key, visit(entry)]),
			);
		return item;
	};
	return visit(value) as T;
}
