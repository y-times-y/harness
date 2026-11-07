/**
 * When and how a builder delegates: one policy for the product's
 * orchestration block (subagent-instructions.ts) and the unattended helper
 * section. Only the mechanics differ and stay with each caller:
 * where a helper runs (a fork or the shared VM vs one container, writers
 * limited by `owns`), how reports arrive (messages vs agent_wait) and how a
 * writer's work is integrated (a patch to apply vs edits in place).
 *
 * The writer and reader rules are a "middle" rule: between a strict
 * helpers=write wording (parts of hours of work) and the product's old
 * wall-clock triggers.
 */

/**
 * Writers: decided once, right after the first look, when the work splits
 * into separate parts that are each a real job; one focused change stays
 * with the builder.
 */
export const WRITER_DELEGATION_POLICY =
	"Writers: decide once, after your first look at the task and its files, and never later. Start writers when the work splits into two or more parts that touch different files, can each be built and checked without the others, and are each a real job on its own (their own investigation, change and checks, not a few edits): one writer per part, started together. Give each writer its own files or directories, never ones another agent changes, and state the interfaces between the parts in the briefs. While they work, do your own part in other files; then integrate their parts and run the final checks yourself. One focused change, even across several files, or steps that depend on each other, you do yourself.";

/** Readers (researcher, reviewer): the cost bar and when it is worth it. */
export const READER_DELEGATION_POLICY =
	"A helper costs about as much as you do and re-reads what it needs; what it buys is time and a smaller context for you. Start one only for an independent investigation likely to take over 10 minutes, while you have other work to do meanwhile; when a broad investigation splits into several such areas, start one per area together. Small, quick or sequential work, or anything you would finish in a few steps, you do yourself.";

/** What every brief carries. */
export const BRIEF_POLICY =
	"Every brief is self-contained: the goal, the paths and findings it needs, constraints and the report format.";

/** Do not wait on helpers; stop the ones no longer needed. */
export const KEEP_WORKING_POLICY =
	"Keep working while helpers run. Once you have what you need, stop running helpers with agent_send instead of waiting for them.";

/** A report is checked before it is relied on. */
export const REPORT_IS_A_CLAIM =
	"A report is a claim: spot-check it before relying on it.";

/** A refused start (depth, budget, concurrency) is not retried. */
export const REFUSED_START = "A refused start means do the work yourself.";
