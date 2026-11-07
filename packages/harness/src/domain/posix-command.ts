export function posixShellQuoted(value: string) {
	return `'${value.replaceAll("'", `'\\''`)}'`;
}

export function posixShellCommand(argv: readonly string[]) {
	if (argv.length === 0)
		throw new Error("A command requires at least one argument.");
	return argv.map(posixShellQuoted).join(" ");
}

/**
 * Shell that creates `path` as a private (0700) directory owned by the user
 * running it, or exits 1 when the path is a symlink, not a directory, or
 * already belongs to someone else. For fixed /tmp paths another guest user
 * could pre-create.
 */
export function privateDirectoryShell(path: string) {
	const quoted = posixShellQuoted(path);
	return `{ [ ! -L ${quoted} ] && install -d -m 0700 ${quoted} 2>/dev/null && [ ! -L ${quoted} ] && [ -n "$(find ${quoted} -maxdepth 0 -type d -user "$(id -u)" -perm 700)" ]; } || { echo "Refusing to use ${path.replaceAll(/["$`\\']/g, "")}: not a private directory owned by this user." >&2; exit 1; }`;
}
