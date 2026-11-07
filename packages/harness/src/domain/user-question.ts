import { isInternalChildTaskMessage } from "./child-task-activity";
import type { SessionItem } from "./session-item";

/**
 * The agent asks the user to choose with this tool when a decision is
 * genuinely theirs; the turn ends and the chat shows the question as a card
 * with options. The answer goes back as an ordinary user message.
 */
export const ASK_USER_TOOL = "ask_user";

export const USER_QUESTION_LIMITS = {
	questions: 4,
	question: 300,
	header: 24,
	options: { min: 2, max: 4 },
	label: 60,
	description: 160,
	answer: 1_000,
} as const;

export type UserQuestionOption = {
	readonly label: string;
	readonly description?: string;
};

export type UserQuestion = {
	readonly question: string;
	/** A short chip naming the topic ("Database", "Auth"). */
	readonly header?: string;
	readonly options: readonly UserQuestionOption[];
	/** Several options may be chosen at once. */
	readonly multiSelect?: boolean;
};

/** The questions an accepted ask_user call returned, if any. */
export function askedQuestions(
	value: unknown,
	failed: boolean | undefined,
): UserQuestion[] | null {
	const output = value as { asked?: unknown; questions?: unknown } | null;
	if (failed || output?.asked !== true || !Array.isArray(output.questions))
		return null;
	const questions = output.questions.flatMap((raw): UserQuestion[] => {
		const question = raw as Partial<UserQuestion> | null;
		if (typeof question?.question !== "string" || !question.question.trim())
			return [];
		const options = (Array.isArray(question.options) ? question.options : [])
			.filter(
				(option): option is UserQuestionOption =>
					typeof option?.label === "string" && !!option.label.trim(),
			)
			.slice(0, USER_QUESTION_LIMITS.options.max)
			.map((option) => ({
				label: option.label.trim().slice(0, USER_QUESTION_LIMITS.label),
				...(typeof option.description === "string" && option.description.trim()
					? {
							description: option.description
								.trim()
								.slice(0, USER_QUESTION_LIMITS.description),
						}
					: {}),
			}));
		if (options.length < USER_QUESTION_LIMITS.options.min) return [];
		return [
			{
				question: question.question
					.trim()
					.slice(0, USER_QUESTION_LIMITS.question),
				...(typeof question.header === "string" && question.header.trim()
					? {
							header: question.header
								.trim()
								.slice(0, USER_QUESTION_LIMITS.header),
						}
					: {}),
				options,
				...(question.multiSelect === true ? { multiSelect: true } : {}),
			},
		];
	});
	return questions.length
		? questions.slice(0, USER_QUESTION_LIMITS.questions)
		: null;
}

/** The user's answers as the message the agent reads next: one line per question. */
export function userQuestionAnswerText(
	questions: readonly UserQuestion[],
	answers: readonly (readonly string[])[],
) {
	return questions
		.map((question, index) => {
			const chosen = (answers[index] ?? [])
				.map((answer) => answer.trim())
				.filter(Boolean);
			const label = question.header ?? question.question;
			return `${label}: ${chosen.length ? chosen.join(", ") : "(no answer)"}`;
		})
		.join("\n")
		.slice(0, USER_QUESTION_LIMITS.answer * USER_QUESTION_LIMITS.questions);
}

/** The reply that answered a question card, if the user has answered it. */
export function userQuestionReply(
	items: readonly SessionItem[],
	questionId: SessionItem["id"],
): string | null {
	const index = items.findIndex((item) => item.id === questionId);
	if (index < 0) return null;
	const reply = items
		.slice(index + 1)
		.find(
			(item) =>
				item.kind === "userMessage" && !isInternalChildTaskMessage(item.text),
		);
	return reply?.kind === "userMessage" ? reply.text : null;
}
