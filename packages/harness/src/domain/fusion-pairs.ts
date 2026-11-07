import type { RoleModels } from "./role-models";

/**
 * Per-pair tuning of lead mode fusion (each
 * lead/sidekick pair is tuned separately): how the lead briefs, whether the
 * sidekick may push back on a brief, and whether the sidekick does the
 * code exploration the lead plans from. Weaker sidekicks get prescriptive
 * briefs and follow them; only stronger ones push back.
 */
export type FusionPairProfile = {
	/** Which entry matched: a named pair, or "default". */
	readonly name: string;
	/** prescriptive: exact files, changes and commands; outcome: goal, constraints, definition of done. */
	readonly briefStyle: "prescriptive" | "outcome";
	/** The sidekick may argue against a brief's approach in its report. */
	readonly pushback: boolean;
	/** The lead's first handoff is an exploration brief; it plans from the snippets returned. */
	readonly sidekickExplores: boolean;
};

/** The model name without its route: `codex:gpt-6-luna@low` and `api/c1/gpt-6-luna` are both gpt-6-luna. */
export function modelName(model: string) {
	const bare = model.split("@")[0] ?? model;
	return (bare.split(/[:/]/).at(-1) ?? bare).toLowerCase();
}

const family = (pattern: string) => new RegExp(`(^|[-_.])${pattern}($|[-_.])`);

/** Small or fast tiers: a sidekick on one of these gets prescriptive briefs and no pushback by default. */
const LIGHT = /(^|[-_.])(luna|mini|nano|flash|lite|haiku|small|fast)($|[-_.])/;

const PAIRS: readonly {
	readonly lead: RegExp;
	readonly sidekick: RegExp;
	readonly profile: FusionPairProfile;
}[] = [
	{
		lead: family("sol"),
		sidekick: family("luna"),
		profile: {
			name: "sol+luna",
			briefStyle: "prescriptive",
			pushback: false,
			sidekickExplores: true,
		},
	},
];

/** The profile of a lead model and its sidekick's model (the same model when the sidekick inherits the lead's). */
export function fusionPairProfile(
	leadModel: string,
	sidekickModel: string,
): FusionPairProfile {
	const lead = modelName(leadModel);
	const sidekick = modelName(sidekickModel);
	const named = PAIRS.find(
		(pair) => pair.lead.test(lead) && pair.sidekick.test(sidekick),
	);
	if (named) return named.profile;
	// Unknown pair: outcome briefs; a sidekick at the lead's tier (or the
	// lead's own model) is strong enough to push back.
	const strong = sidekick === lead || !LIGHT.test(sidekick);
	return {
		name: "default",
		briefStyle: "outcome",
		pushback: strong,
		sidekickExplores: true,
	};
}

/** The pair for a lead whose sidekick runs on roleModels.writer (else on the lead's own model). */
export function fusionPairFor(
	leadModel: string | null | undefined,
	roleModels: RoleModels | undefined,
): FusionPairProfile {
	const lead = leadModel ?? "";
	return fusionPairProfile(lead, roleModels?.writer?.model ?? lead);
}
