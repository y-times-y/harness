import { unwrapShellCommand } from "./visible-shell-command";

/** Conservative display labels; the full command remains available on expansion. */
export function commandActivityTitle(command: string): string {
	const text = unwrapShellCommand(command);
	if (/[;&|\n]/.test(text)) return "Run shell commands";
	if (/^git\s+status\b/.test(text)) return "Check working tree";
	if (/^git\s+diff\b/.test(text)) return "Inspect changes";
	if (/^git\s+log\b/.test(text)) return "Inspect commit history";
	if (/^gh\s+issue\s+(list|view)\b/.test(text))
		return "Inspect repository issues";
	if (/^gh\s+pr\s+(list|view|checks|diff)\b/.test(text))
		return "Inspect pull requests";
	if (
		/^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|vitest)\b/.test(
			text,
		)
	)
		return "Run tests";
	if (
		/^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?typecheck\b/.test(text)
	)
		return "Check types";
	if (/^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?build\b/.test(text))
		return "Build project";
	if (/^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?lint\b/.test(text))
		return "Run lint checks";
	if (/^(?:corepack\s+)?(?:npm|pnpm|yarn|bun)\s+(?:install|ci)\b/.test(text))
		return "Install dependencies";
	if (/^(?:rg|grep|find)\s/.test(text)) return "Search files";
	if (/^(?:cat|head|tail|sed)\s/.test(text)) return "Inspect file contents";
	if (/^ls\b/.test(text)) return "List files";
	return "Run shell command";
}
