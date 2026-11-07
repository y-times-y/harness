export function unwrapShellCommand(command: string): string {
	const trimmed = command.trim();
	const wrapped = trimmed.match(/^\/bin\/(?:ba)?sh\s+-lc\s+(['"])([\s\S]*)\1$/);
	const inner = wrapped?.[2]?.trim() ?? trimmed;
	const afterCd = inner.match(/^cd\s+\S+\s+&&\s+([\s\S]+)$/);
	return (afterCd?.[1] ?? inner).trim();
}
