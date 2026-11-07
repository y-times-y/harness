import { z } from "zod";

export const repositoryToolPath = z
	.string()
	.min(1)
	.max(2048)
	.refine(
		(path) =>
			!path.startsWith("/") &&
			!/[\\\0]/.test(path) &&
			!path.split("/").some((part) => part === ".." || part === ".git"),
		"Use a repository-relative path outside .git without traversal.",
	);
