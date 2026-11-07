import { asSchema, type Tool } from "ai";

/**
 * Compact TypeScript-like declarations of tools a run_code program calls
 * without having their schemas in the request (code mode primary):
 * searchTools(query) returns them, so the model learns a deferred tool's
 * arguments from inside a program instead of loading it into the tool list.
 */

type Schema = {
	type?: string | string[];
	properties?: Record<string, Schema>;
	required?: string[];
	items?: Schema;
	enum?: unknown[];
	const?: unknown;
	anyOf?: Schema[];
	oneOf?: Schema[];
	description?: string;
	additionalProperties?: boolean | Schema;
};

const DESCRIPTION_CHARACTERS = 600;
const PROPERTY_NOTE_CHARACTERS = 120;
const MAX_DEPTH = 4;

const oneLine = (text: string) => text.replace(/\s+/g, " ").trim();
const clip = (text: string, limit: number) =>
	text.length > limit ? `${text.slice(0, limit - 3)}...` : text;
const key = (name: string) =>
	/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? name : JSON.stringify(name);

/** A JSON schema as a TypeScript type; nested objects are indented under `indent`. */
export function schemaType(
	schema: Schema | undefined,
	indent = "",
	depth = 0,
): string {
	if (!schema || typeof schema !== "object") return "unknown";
	if (schema.const !== undefined) return JSON.stringify(schema.const);
	if (Array.isArray(schema.enum))
		return schema.enum.map((value) => JSON.stringify(value)).join(" | ");
	const union = schema.anyOf ?? schema.oneOf;
	if (Array.isArray(union))
		return union.map((part) => schemaType(part, indent, depth)).join(" | ");
	const type = Array.isArray(schema.type) ? schema.type : [schema.type];
	if (type.length > 1)
		return type
			.map((part) => schemaType({ ...schema, type: part }, indent, depth))
			.join(" | ");
	switch (type[0]) {
		case "string":
			return "string";
		case "number":
		case "integer":
			return "number";
		case "boolean":
			return "boolean";
		case "null":
			return "null";
		case "array": {
			const item = schemaType(schema.items, indent, depth + 1);
			return /[|\s]/.test(item) && !item.startsWith("{")
				? `Array<${item}>`
				: `${item}[]`;
		}
		case "object":
		case undefined: {
			const properties = Object.entries(schema.properties ?? {});
			if (!properties.length)
				return schema.type === "object" || schema.additionalProperties
					? "Record<string, unknown>"
					: "unknown";
			if (depth >= MAX_DEPTH) return "object";
			const required = new Set(schema.required ?? []);
			const inner = `${indent}  `;
			const lines = properties.map(([name, property]) => {
				const note = property?.description
					? ` // ${clip(oneLine(property.description), PROPERTY_NOTE_CHARACTERS)}`
					: "";
				return `${inner}${key(name)}${required.has(name) ? "" : "?"}: ${schemaType(property, inner, depth + 1)};${note}`;
			});
			return `{\n${lines.join("\n")}\n${indent}}`;
		}
		default:
			return "unknown";
	}
}

/** One tool's declaration: its description as a doc comment, then `tools.<name>(args: …)`. */
export async function toolDeclaration(name: string, definition: Tool) {
	const schema = (await asSchema(definition.inputSchema).jsonSchema) as Schema;
	const description =
		typeof definition.description === "string"
			? clip(oneLine(definition.description), DESCRIPTION_CHARACTERS)
			: "";
	return `${description ? `/** ${description.replaceAll("*/", "* /")} */\n` : ""}tools.${name}(args: ${schemaType(schema)}): Promise<unknown>`;
}
