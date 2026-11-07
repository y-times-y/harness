// The compiler is large; loading it on the first edit keeps it out of Worker startup.
let compiler: Promise<typeof import("typescript")> | undefined;
const typescript = () =>
	(compiler ??= import("typescript").then(
		(module) => (module.default ?? module) as typeof import("typescript"),
	));

/** Syntax feedback only: type safety and behavioral correctness still require project checks. */
export async function editDiagnostics(
	path: string,
	content: string | undefined,
) {
	if (
		!/\.(?:[cm]?[jt]sx?)$/.test(path) ||
		/\.d\.[cm]?ts$/.test(path) ||
		content === undefined
	)
		return { syntaxChecked: false, diagnostics: [] as string[] };
	const ts = await typescript();
	const result = ts.transpileModule(content, {
		fileName: path,
		reportDiagnostics: true,
		compilerOptions: {
			target: ts.ScriptTarget.ESNext,
			module: ts.ModuleKind.ESNext,
			jsx: ts.JsxEmit.Preserve,
			isolatedModules: true,
		},
	});
	return {
		syntaxChecked: true,
		diagnostics: (result.diagnostics ?? [])
			.filter(
				(diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error,
			)
			.slice(0, 10)
			.map((diagnostic) => {
				const position =
					diagnostic.start === undefined || !diagnostic.file
						? null
						: diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
				return `${position ? `${position.line + 1}:${position.character + 1} ` : ""}${ts.flattenDiagnosticMessageText(diagnostic.messageText, " ")}`;
			}),
	};
}
