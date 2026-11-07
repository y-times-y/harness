import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { runGuestCapability } from "./guest-node-capability";
import { repositoryToolPath } from "./repository-tool-path";
import { TREE_SITTER_OUTLINE_SOURCE } from "./tree-sitter-outlines";

const selection = z.discriminatedUnion("view", [
	z.object({ path: repositoryToolPath, view: z.literal("outline") }),
	z.object({
		path: repositoryToolPath,
		view: z.literal("lines"),
		startLine: z.number().int().min(1),
		endLine: z.number().int().min(1),
		expectedSha256: z
			.string()
			.regex(/^[a-f0-9]{64}$/)
			.optional(),
	}),
]);
const codeReadRequest = z.object({
	files: z.array(selection).min(1).max(4),
});
const result = z.object({ files: z.array(z.unknown()).max(4) });

export function structuredCodeTools(
	input: AgentToolWorkspaceInput & { signal: AbortSignal },
): ToolSet {
	return {
		read_code: tool({
			description:
				"Inspect up to four files in one VM request. Use outline for locating declarations in large files, then read exact source. TS/JS/TSX/JSX use TypeScript; Python, Rust, Go, C/C++, C#, Java, Ruby, PHP, Swift, Dart, Solidity, CSS and Vue use maintained Tree-sitter grammars: parser-derived declarations, signatures, class members and 1-based line spans without bodies. Outlines are incomplete source evidence; follow with lines for exact content. Line ranges support any UTF-8 file and may bind expectedSha256 from the outline to reject changes. Prefer read_file for small files. Unsupported outlines return an explicit status; use read_file instead. Source files max 1 MiB; combined selected text max 60,000 characters; narrow oversized ranges. Does not execute repository code or start a language server.",
			inputSchema: codeReadRequest,
			execute: async (args) => {
				const request = codeReadRequest.parse(args);
				const workspace = await resolveToolWorkspace(input);
				return runGuestCapability(
					workspace,
					"language",
					STRUCTURED_CODE_READ_SOURCE,
					{ ...request, cwd: workspace.cwd },
					result,
					input.signal,
				);
			},
		}),
	};
}

// TypeScript supplies syntax structure; custom code only shapes bounded observations and repository boundaries.
export const STRUCTURED_CODE_READ_SOURCE = String.raw`
import {createRequire} from 'node:module';
import {readFile, realpath, stat} from 'node:fs/promises';
import {resolve, sep} from 'node:path';
import {createHash} from 'node:crypto';
import {TextDecoder} from 'node:util';
const require = createRequire(process.argv[1] + '/package.json');
const {TextDocument} = require('vscode-languageserver-textdocument');
${TREE_SITTER_OUTLINE_SOURCE}
const input = JSON.parse(process.argv[2]);
const root = await realpath(input.cwd);
if (!Array.isArray(input.files) || input.files.length < 1 || input.files.length > 4) throw new Error('Invalid read batch.');
let characters = 0;
const files = [];
for (const request of input.files) {
  if (typeof request.path !== 'string' || request.path.startsWith('/') || request.path.includes('\\') || request.path.split('/').some(p => p === '..' || p === '.git')) throw new Error('Invalid repository path.');
  const file = await realpath(resolve(root, request.path));
  if (!file.startsWith(root + sep) || file.slice(root.length + 1).split(sep).includes('.git')) throw new Error('Read escapes repository.');
  if (!(await stat(file)).isFile() || (await stat(file)).size > 1048576) throw new Error('Read requires a regular file up to 1 MiB.');
  const buffer = await readFile(file);
  if (buffer.length > 1048576) throw new Error('Source grew beyond read limit.');
  const content = new TextDecoder('utf-8', {fatal:true, ignoreBOM:true}).decode(buffer);
  const sha256 = createHash('sha256').update(buffer).digest('hex');
  if (request.expectedSha256 && request.expectedSha256 !== sha256) throw new Error('File changed since outline; inspect it again.');
  const lines = content.split(/\r\n|\n|\r/);
  const metadata = {path:request.path, sha256, totalLines:lines.length};
  if (request.view === 'lines') {
    if (!Number.isInteger(request.startLine) || !Number.isInteger(request.endLine) || request.startLine < 1 || request.endLine < request.startLine || request.endLine > lines.length || request.endLine - request.startLine >= 1000) throw new Error('Invalid or oversized line range.');
    const start = request.startLine, end = request.endLine;
    const source = TextDocument.create(request.path, '', 0, content);
    const from = source.offsetAt({line:start-1,character:0});
    const to = end < lines.length ? source.offsetAt({line:end,character:0}) : content.length;
    const text = content.slice(from, to);
    characters += text.length;
    if (characters > 60000) throw new Error('Selected text exceeds batch limit; narrow ranges or use read_file.');
    files.push({...metadata, view:'lines', startLine:start, endLine:end, content:text, completeFile:start === 1 && end === lines.length});
    continue;
  }
  if (request.view !== 'outline') throw new Error('Unknown view.');
  if (!/\.[cm]?[jt]sx?$/.test(request.path)) { files.push(await treeSitterOutline(request.path, content, metadata)); continue; }
  const ts = require('typescript');
  const source = ts.createSourceFile(request.path, content, ts.ScriptTarget.Latest, true);
  const declarations = [];
  let omitted = 0;
  function record(node, parent) {
    const start = node.getStart(source), end = node.getEnd();
    let signature;
    if (ts.isVariableDeclaration(node) || ts.isPropertyDeclaration(node)) signature = node.name.getText(source) + (node.type ? ': ' + node.type.getText(source) : '') + (node.initializer ? ' = ' + ((ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) ? content.slice(node.initializer.getStart(source), node.initializer.body.getStart(source)) : '[' + ts.SyntaxKind[node.initializer.kind] + ']') : '');
    else signature = content.slice(start, node.body?.getStart(source) ?? ((ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) ? node.members.pos - 1 : end));
    signature = signature.replace(/\s+/g, ' ').trim();
    const signatureTruncated = signature.length > 320;
    signature = signature.slice(0, 320);
    if (declarations.length >= 200 || characters + signature.length > 60000) { omitted++; return; }
    characters += signature.length;
    declarations.push({kind:ts.SyntaxKind[node.kind], name:node.name?.getText(source) ?? null, parent:parent ?? null, startLine:source.getLineAndCharacterOfPosition(start).line + 1, endLine:source.getLineAndCharacterOfPosition(Math.max(start, end - 1)).line + 1, signature, signatureTruncated});
  }
  function recordStatement(node) {
    if (declarations.length >= 200) { omitted++; return; }
    declarations.push({kind:ts.SyntaxKind[node.kind], name:null, parent:null, startLine:source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1, endLine:source.getLineAndCharacterOfPosition(Math.max(node.getStart(source), node.getEnd() - 1)).line + 1, signature:'[statement omitted]', signatureTruncated:false});
  }
  for (const node of source.statements) {
    if (ts.isVariableStatement(node)) { for (const declaration of node.declarationList.declarations) record(declaration); }
    else {
      if ((ts.isFunctionDeclaration(node) || ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node) || ts.isEnumDeclaration(node) || ts.isModuleDeclaration(node)) || ts.isImportDeclaration(node) || ts.isExportDeclaration(node) || ts.isExportAssignment(node)) record(node);
      else recordStatement(node);
      if (ts.isClassDeclaration(node) || ts.isInterfaceDeclaration(node)) for (const member of node.members) record(member, node.name?.getText(source));
    }
  }
  files.push({...metadata, view:'outline', status:source.parseDiagnostics.length ? 'syntax_errors' : 'ok', declarations, omittedDeclarations:omitted, truncated:omitted > 0, completeSource:false, parseDiagnostics:source.parseDiagnostics.slice(0, 10).map(d => ts.flattenDiagnosticMessageText(d.messageText, ' '))});
}
console.log(JSON.stringify({files}));
`;
