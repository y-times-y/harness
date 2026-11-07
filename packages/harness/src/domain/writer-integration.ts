/**
 * How a builder integrates a writer that worked on its own copy of the
 * checkout and returned a patch and git ref (a product writer on a VM fork,
 * or a helpers=write-tree writer on a git worktree): one
 * sentence. Used by the product orchestration block (subagent-instructions.ts)
 * and the unattended helper section. The builder stages
 * its own work first: `git apply -3` works on the index and refuses a file
 * whose unstaged edits differ from it ("does not match index"), even when
 * the hunks do not overlap; once staged, non-overlapping hunks apply and
 * overlapping ones become conflicts to resolve (the 2026-10-28 live test).
 */
export const WRITER_PATCH_APPLY = (patch: string) =>
	`git add -A && git apply -3 ${patch}`;

export const WRITER_PATCH_INTEGRATION = `Integrate a writer's part by reviewing its patch (\`git diff <base> <ref>\`), applying it with \`${WRITER_PATCH_APPLY("<patch>")}\` (your own edits staged first) and rerunning its checks yourself.`;
