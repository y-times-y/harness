import fs from "node:fs";
import path from "node:path";

/**
 * .env and .env.local of a folder, read by the CLI itself: the values go to
 * the secrets endpoint and into redaction, and only the names are ever shown.
 */

export type EnvVariable = {
	readonly name: string;
	readonly value: string;
	readonly source: ".env" | ".env.local";
};

export const ENV_FILES = [".env", ".env.local"] as const;

const NAME = /^[A-Za-z_][A-Za-z0-9_.-]*$/;

function unescapeDouble(text: string) {
	return text.replace(/\\([nrt"\\$])/g, (_, char: string) =>
		char === "n" ? "\n" : char === "r" ? "\r" : char === "t" ? "\t" : char,
	);
}

/**
 * Parses dotenv text: `KEY=value`, an optional `export ` prefix, `#` comments
 * (whole lines, and after an unquoted value when a space precedes them),
 * single quotes (literal), double quotes (with \n, \t, \" escapes) and
 * backticks, any of which may span lines. Later keys win.
 */
export function parseEnvText(text: string): { name: string; value: string }[] {
	const variables = new Map<string, string>();
	const source = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
	let index = 0;
	while (index < source.length) {
		const lineEnd = source.indexOf("\n", index);
		const end = lineEnd === -1 ? source.length : lineEnd;
		const line = source.slice(index, end);
		const match = /^\s*(?:export\s+)?([^=\s]+)\s*=\s*/.exec(line);
		if (!match || line.trimStart().startsWith("#")) {
			index = end + 1;
			continue;
		}
		const name = match[1] as string;
		const valueStart = index + match[0].length;
		const quote = source[valueStart];
		let value: string;
		if (quote === '"' || quote === "'" || quote === "`") {
			const close = source.indexOf(quote, valueStart + 1);
			let at = close;
			// A double-quoted value may contain escaped quotes.
			while (quote === '"' && at !== -1) {
				let slashes = 0;
				for (let back = at - 1; source[back] === "\\"; back--) slashes++;
				if (slashes % 2 === 0) break;
				at = source.indexOf(quote, at + 1);
			}
			if (at === -1) {
				// Unterminated: take the rest of the line as written.
				value = line.slice(match[0].length).trim();
				index = end + 1;
			} else {
				const raw = source.slice(valueStart + 1, at);
				value = quote === '"' ? unescapeDouble(raw) : raw;
				const after = source.indexOf("\n", at);
				index = after === -1 ? source.length : after + 1;
			}
		} else {
			value = line
				.slice(match[0].length)
				.replace(/(^|\s)#.*$/, "")
				.trim();
			index = end + 1;
		}
		if (NAME.test(name)) variables.set(name, value);
	}
	return [...variables].map(([name, value]) => ({ name, value }));
}

/** The folder's .env and .env.local variables (missing or unreadable files give none). */
export function readEnvFiles(folder: string): EnvVariable[] {
	const variables: EnvVariable[] = [];
	for (const source of ENV_FILES) {
		let text: string;
		try {
			const file = path.join(folder, source);
			if (!fs.statSync(file).isFile()) continue;
			text = fs.readFileSync(file, "utf8");
		} catch {
			continue;
		}
		for (const variable of parseEnvText(text))
			variables.push({ ...variable, source });
	}
	return variables;
}

const TOO_COMMON =
	/^(?:true|false|yes|no|null|none|on|off|development|production|staging|test|localhost|127\.0\.0\.1|0\.0\.0\.0|\d+(?:\.\d+)?)$/i;

/**
 * The values worth redacting from uploads: long enough to be a secret and not
 * a word that would blank out ordinary text ("true", "3000", "production").
 */
export function redactionValues(variables: readonly { value: string }[]) {
	const values = new Set<string>();
	for (const { value } of variables) {
		const trimmed = value.trim();
		if (trimmed.length >= 8 && !TOO_COMMON.test(trimmed)) values.add(trimmed);
		if (value.length >= 8 && value !== trimmed && !TOO_COMMON.test(value))
			values.add(value);
	}
	return [...values];
}
