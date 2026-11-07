/** Maintained WASM grammars supply syntax; this adapter only shapes bounded declarations. */
export const TREE_SITTER_OUTLINE_SOURCE = String.raw`
const grammarByExtension = {py:'python', rs:'rust', go:'go', c:'c', h:'c', cc:'cpp', cpp:'cpp', cxx:'cpp', hpp:'cpp', cs:'c_sharp', java:'java', rb:'ruby', php:'php', swift:'swift', dart:'dart', sol:'solidity', css:'css', vue:'vue'};
const declarationTypes = new Set(['function_definition','function_declaration','method_definition','method_declaration','constructor_declaration','class_definition','class_declaration','struct_specifier','enum_specifier','function_item','struct_item','enum_item','trait_item','impl_item','type_item','mod_item','type_declaration','interface_declaration','record_declaration','enum_declaration','namespace_definition','module','class','method','singleton_method','function_signature','protocol_declaration','extension_declaration','mixin_declaration','rule_set']);
async function treeSitterOutline(path, content, metadata) {
  const grammar = grammarByExtension[path.split('.').pop()?.toLowerCase()];
  if (!grammar) return {...metadata, view:'outline', status:'unsupported', instruction:'Use read_file or a line selection for exact source.'};
  const {Parser, Language} = require('web-tree-sitter');
  await Parser.init();
  const language = await Language.load(process.argv[1] + '/node_modules/@repomix/tree-sitter-wasms/out/tree-sitter-' + grammar + '.wasm');
  const parser = new Parser();
  parser.setLanguage(language);
  let tree;
  try {
    tree = parser.parse(content);
    if (!tree) throw new Error('Parser did not produce a syntax tree.');
    const declarations = [];
    let visited = 0, omitted = 0;
    function visit(node, parent = null) {
      if (++visited > 20000) { omitted++; return; }
      const declaration = declarationTypes.has(node.type) && !(node.type === 'module' && !node.parent);
      const body = node.childForFieldName('body') ?? node.namedChildren.find(child => ['declaration_list','field_declaration_list','class_body','block','compound_statement'].includes(child.type));
      const name = node.childForFieldName('name') ?? node.childForFieldName('declarator') ?? node.childForFieldName('type');
      if (declaration) {
        const signature = content.slice(node.startIndex, body?.startIndex ?? node.endIndex).replace(/\s+/g, ' ').trim();
        if (declarations.length >= 200 || characters + Math.min(signature.length, 320) > 60000) { omitted++; return; }
        characters += Math.min(signature.length, 320);
        declarations.push({kind:node.type, name:name?.text ?? null, parent, startLine:node.startPosition.row + 1, endLine:node.endPosition.row + 1, signature:signature.slice(0,320), signatureTruncated:signature.length > 320});
      }
      // Visit members, but never descend into function bodies or retain their statements.
      if (declaration && /function|method|constructor/.test(node.type)) return;
      for (const child of node.namedChildren) visit(child, declaration ? name?.text ?? parent : parent);
    }
    visit(tree.rootNode);
    return {...metadata, view:'outline', language:grammar, status:tree.rootNode.hasError ? 'syntax_errors' : 'ok', declarations, omittedDeclarations:omitted, truncated:omitted > 0, completeSource:false, parseDiagnostics:tree.rootNode.hasError ? ['Syntax tree contains errors; read exact source before editing.'] : []};
  } finally { tree?.delete(); parser.delete(); }
}
`;
