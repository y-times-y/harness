declare const brand: unique symbol;

export type Brand<Value extends string, Name extends string> = Value & {
	readonly [brand]: Name;
};

function brandedId<Name extends string>(
	name: Name,
	value: string,
): Brand<string, Name> {
	const trimmed = value.trim();
	if (trimmed.length === 0) {
		throw new Error(`${name} requires a non-empty value`);
	}
	return trimmed as Brand<string, Name>;
}

export type UserId = Brand<string, "UserId">;
export type ProjectId = Brand<string, "ProjectId">;
export type WorkspaceId = Brand<string, "WorkspaceId">;
export type SessionId = Brand<string, "SessionId">;
export type JobId = Brand<string, "JobId">;
export type AuthSnapshotId = Brand<string, "AuthSnapshotId">;
export type SessionItemId = Brand<string, "SessionItemId">;

export const UserId = (value: string) => brandedId("UserId", value);
export const ProjectId = (value: string) => brandedId("ProjectId", value);
export const WorkspaceId = (value: string) => brandedId("WorkspaceId", value);
export const SessionId = (value: string) => brandedId("SessionId", value);
export const JobId = (value: string) => brandedId("JobId", value);
export const AuthSnapshotId = (value: string) =>
	brandedId("AuthSnapshotId", value);
export const SessionItemId = (value: string) =>
	brandedId("SessionItemId", value);
