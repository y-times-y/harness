import { expect, it } from "vitest";
import { applyApiProgress } from "./api-progress";
import { SessionItemId } from "./ids";
import type { SessionItem } from "./session-item";
import {
	askedQuestions,
	userQuestionAnswerText,
	userQuestionReply,
} from "./user-question";

const database = {
	question: "Which database should the app use?",
	header: "Database",
	options: [
		{ label: "Postgres (recommended)", description: "Managed, scales well" },
		{ label: "SQLite" },
	],
};

it("keeps only well-formed questions, trimmed and bounded", () => {
	expect(askedQuestions({ asked: true, questions: [database] }, false)).toEqual(
		[database],
	);
	// A question needs at least two labelled options.
	expect(
		askedQuestions(
			{
				asked: true,
				questions: [{ question: "Go?", options: [{ label: "Yes" }] }],
			},
			false,
		),
	).toBeNull();
	expect(
		askedQuestions({ asked: true, questions: [database] }, true),
	).toBeNull();
	expect(askedQuestions({ asked: false }, false)).toBeNull();
	const long = askedQuestions(
		{
			asked: true,
			questions: [
				{
					question: "x".repeat(500),
					options: [{ label: "a".repeat(90) }, { label: "b" }, { label: " " }],
				},
			],
		},
		false,
	);
	expect(long?.[0].question).toHaveLength(300);
	expect(long?.[0].options.map((option) => option.label.length)).toEqual([
		60, 1,
	]);
});

it("answers in one line per question, naming each by its chip", () => {
	expect(
		userQuestionAnswerText(
			[database, { ...database, header: undefined, multiSelect: true }],
			[["Postgres (recommended)"], ["SQLite", "Something else"]],
		),
	).toBe(
		"Database: Postgres (recommended)\nWhich database should the app use?: SQLite, Something else",
	);
});

it("records an accepted ask_user call as a question card and finds its reply", () => {
	const asked = applyApiProgress([], "t1", {
		type: "tool-result",
		id: "call-1",
		name: "ask_user",
		output: { asked: true, questions: [database] },
	});
	expect(asked).toEqual([
		expect.objectContaining({ kind: "userQuestion", questions: [database] }),
	]);
	const question = asked[0] as SessionItem;
	expect(userQuestionReply(asked, question.id)).toBeNull();
	const answered: SessionItem[] = [
		...asked,
		{
			kind: "userMessage",
			id: SessionItemId("u2"),
			text: "Database: SQLite",
		},
	];
	expect(userQuestionReply(answered, question.id)).toBe("Database: SQLite");
});
