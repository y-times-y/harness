const SECRET_PATTERNS: readonly RegExp[] = [
	/\b(?:sk|pk|rk|ghp|gho|ghs|ghu|github_pat|phc|xox[abp])[-_][A-Za-z0-9_-]{8,}/g,
	// Google API keys.
	/\bAIza[0-9A-Za-z_-]{20,}/g,
	// JWTs (header.payload[.signature]).
	/\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}(?:\.[A-Za-z0-9_-]*)?/g,
	/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi,
	// AWS access key ids (also inside presigned URLs' X-Amz-Credential).
	/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
	// Credential-looking query/form values of any length.
	/\b((?:access_|refresh_|id_)?token|code|key|secret|password|api_key|apikey|signature|sig|state|verifier)=[^&\s"'#]+/gi,
	/\/\/[^/\s:@]+:[^/\s@]+@/g,
	/\b[A-Za-z0-9_+-]{40,}={0,2}/g,
];

/**
 * Header and JSON style credentials (`Authorization: Basic ..`, `x-api-key: ..`,
 * `"token": ".."`): the name and separator stay, the value goes.
 */
const CREDENTIAL_FIELD =
	/\b((?:x-)?api[-_]?key|(?:proxy-)?authorization|(?:access|refresh|id)[-_]?token|token|client[-_]?secret|secret|password)(["']?\s*[:=]\s*["']?)(?:(?:Basic|Bearer|Token)\s+)?[^\s"',;}&]+/gi;

/** Text with tokens, credentials in URLs and long opaque strings removed. */
export function redactSecrets(text: string, limit = 4000) {
	let redacted = text.replace(
		CREDENTIAL_FIELD,
		(_match, name: string, separator: string) =>
			`${name}${separator}[redacted]`,
	);
	for (const pattern of SECRET_PATTERNS)
		redacted = redacted.replace(pattern, (match, name?: string) =>
			match.startsWith("//")
				? "//[redacted]@"
				: typeof name === "string" && match.includes("=")
					? `${name}=[redacted]`
					: "[redacted]",
		);
	return redacted.slice(0, limit);
}

/** Every string inside a JSON-like value, redacted (depth-limited). */
export function redactDeep(value: unknown, depth = 0): unknown {
	if (typeof value === "string") return redactSecrets(value);
	if (depth > 8 || value === null || typeof value !== "object") return value;
	if (Array.isArray(value))
		return value.map((item) => redactDeep(item, depth + 1));
	return Object.fromEntries(
		Object.entries(value).map(([key, item]) => [
			key,
			redactDeep(item, depth + 1),
		]),
	);
}

/** A URL without its query string or fragment; null for /auth/* pages. */
export function replaySafeUrl(href: string): string | null {
	try {
		const url = new URL(href);
		if (url.pathname === "/auth" || url.pathname.startsWith("/auth/"))
			return null;
		return `${url.origin}${url.pathname}`;
	} catch {
		return href.split(/[?#]/)[0] ?? "";
	}
}
