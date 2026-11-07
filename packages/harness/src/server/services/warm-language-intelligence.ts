/** Both client and language-server transport use the maintained JSON-RPC implementation. */
export const WARM_LANGUAGE_INTELLIGENCE_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile, realpath, stat, lstat, unlink, access } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { tmpdir } from 'node:os';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { createConnection, createServer } from 'node:net';
const require = createRequire(process.argv[1] + '/package.json');
const { createMessageConnection, StreamMessageReader, StreamMessageWriter } = require('vscode-jsonrpc/node');
const input = JSON.parse(process.argv[2]);
const root = await realpath(input.cwd);
const language = /\.[cm]?tsx?$/.test(input.path) ? 'typescript' : /\.[cm]?jsx?$/.test(input.path) ? 'javascript' : /\.py$/.test(input.path) ? 'python' : /\.rs$/.test(input.path) ? 'rust' : /\.go$/.test(input.path) ? 'go' : null;
if (!language) throw new Error('No configured language server for this file type.');
const identity = createHash('sha256').update(JSON.stringify([root, language, process.argv[1], 'semantic-refactor-v3'])).digest('hex').slice(0, 20);
const directory = join(tmpdir(), 'yt-lsp-' + process.getuid() + '-' + identity);
await mkdir(directory, { mode: 0o700 }).catch(error => { if(error.code !== 'EEXIST') throw error; });
const directoryInfo = await lstat(directory);
if (!directoryInfo.isDirectory() || directoryInfo.uid !== process.getuid() || (directoryInfo.mode & 0o777) !== 0o700) throw new Error('Unsafe language-server socket directory.');
const socketPath = join(directory, 'rpc');
const rpc = stream => createMessageConnection(new StreamMessageReader(stream), new StreamMessageWriter(stream));

if (!input.daemon) {
  const connect = async () => {
    const previous = await lstat(socketPath).catch(() => null);
    return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    socket.once('error', error => { error.socketIdentity = previous; socket.destroy(); reject(error); });
    socket.once('connect', () => { socket.removeAllListeners('error'); resolve(socket); });
    });
  };
  let socket;
  try { socket = await connect(); }
  catch (error) {
    if (!['ENOENT','ECONNREFUSED'].includes(error.code)) throw error;
    if (input.onlyIfWarm) { console.log(JSON.stringify({ available: false })); process.exit(0); }
    if (error.code === 'ECONNREFUSED') {
      const info = await lstat(socketPath).catch(() => null);
      if (info?.isSocket() && info.uid === process.getuid() && info.ino === error.socketIdentity?.ino && info.dev === error.socketIdentity?.dev) await unlink(socketPath).catch(() => {});
    }
    const daemon = spawn(process.execPath, [...process.execArgv, process.argv[1], JSON.stringify({...input, daemon: true})], { cwd: root, detached: true, stdio: 'ignore' });
    daemon.unref();
    const deadline = Date.now() + 10000;
    while (!socket) {
      try { socket = await connect(); } catch (retry) {
        if (!['ENOENT','ECONNREFUSED'].includes(retry.code) || Date.now() > deadline) throw retry;
        await new Promise(resolve => setTimeout(resolve, 50));
      }
    }
  }
  const connection = rpc(socket);
  connection.listen();
  let timeout;
  try {
    const result = await Promise.race([
      input.requests ? (async () => { const results = []; for (const request of input.requests) results.push(await connection.sendRequest('inspect', {...request, cwd: input.cwd})); return {results}; })() : connection.sendRequest(input.shutdown ? 'shutdown' : 'inspect', input),
      new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Language request timed out.')), 40000); })
    ]);
    console.log(JSON.stringify(input.onlyIfWarm ? { available: true, ...result } : result));
  } finally { clearTimeout(timeout); connection.dispose(); socket.destroy(); }
} else {
  const clients = new Set();
  let child, connection, idle;
  let serial = Promise.resolve();
  let closing = false;
  const server = createServer(socket => {
    clients.add(socket);
    socket.on('close', () => clients.delete(socket));
    const client = rpc(socket);
    client.onRequest('inspect', request => {
      clearTimeout(idle);
      const operation = serial.then(() => inspect(request));
      serial = operation.catch(() => {});
      return operation.finally(() => { idle = setTimeout(shutdown, 60000); });
    });
    client.onRequest('shutdown', () => { setTimeout(shutdown, 20); return { stopped: true }; });
    client.listen();
  });
  const stopServer = signal => { try { if (child?.pid) process.kill(-child.pid, signal); } catch {} };
  async function shutdown() {
    if (closing) return;
    closing = true;
    clearTimeout(idle);
    connection?.dispose();
    stopServer('SIGTERM');
    server.close();
    for (const socket of clients) socket.destroy();
    await new Promise(resolve => setTimeout(resolve, 100));
    stopServer('SIGKILL');
    await unlink(socketPath).catch(() => {});
    process.exit(0);
  }
  // Bind before starting the expensive project server; concurrent starters lose safely.
  try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(socketPath, resolve); }); }
  catch (error) { if (error.code === 'EADDRINUSE') process.exit(0); throw error; }
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  const tsServer = process.argv[1] + '/node_modules/.bin/typescript-language-server';
  const installed = async name => {const file=process.argv[1]+'/bin/'+name;return await access(file).then(()=>file,()=>name);};
  const commands = { typescript: [tsServer, '--stdio'], javascript: [tsServer, '--stdio'], python: [process.argv[1] + '/node_modules/.bin/pyright-langserver', '--stdio'], rust: [await installed('rust-analyzer')], go: [await installed('gopls'), 'serve'] };
  const [command, ...args] = commands[language];
  child = spawn(command, args, { cwd: root, detached: true, stdio: ['pipe', 'pipe', 'pipe'] });
  child.stderr.on('data', () => {});
  child.on('error', shutdown);
  child.on('exit', shutdown);
  connection = createMessageConnection(new StreamMessageReader(child.stdout), new StreamMessageWriter(child.stdin));
  const documents = new Map();
  connection.onNotification('textDocument/publishDiagnostics', value => {
    const document = documents.get(value.uri);
    if (document && (value.version === undefined || value.version === document.version)) {
      document.observed = true;
      document.diagnostics = value.diagnostics.slice(0, 100);
      document.truncated = value.diagnostics.length > 100;
      document.resolve();
    }
  });
  connection.onRequest('workspace/configuration', value => value.items.map(() => null));
  connection.onRequest('workspace/applyEdit', () => ({ applied: false, failureReason: 'This capability only previews edits.' }));
  connection.listen();
  let serverCapabilities;
  const initialized = (async () => {
    const initializedResult = await connection.sendRequest('initialize', { processId: process.pid, rootUri: pathToFileURL(root).href, workspaceFolders: [{uri: pathToFileURL(root).href, name: 'task'}], initializationOptions: {tsserver: {useSyntaxServer: 'never'}}, capabilities: {workspace: {configuration: true, workspaceEdit: {documentChanges: true}, fileOperations: {willRename:true, didRename:true}}, textDocument: {publishDiagnostics: {versionSupport: true}, codeAction: {codeActionLiteralSupport: {codeActionKind: {valueSet:['quickfix','refactor','source.organizeImports']}}, resolveSupport: {properties:['edit']}}}} });
    serverCapabilities = initializedResult.capabilities;
    await connection.sendNotification('initialized', {});
  })();
  initialized.catch(shutdown);
  idle = setTimeout(shutdown, 60000);
  async function inspect(request) {
    let watchdog;
    try {
      return await Promise.race([perform(request), new Promise((_, reject) => { watchdog = setTimeout(() => { reject(new Error('Language server stalled.')); void shutdown(); }, 35000); })]);
    } finally { clearTimeout(watchdog); }
  }
  async function perform(request) {
    if (await realpath(request.cwd) !== root) throw new Error('Project mismatch.');
    if (request.deleted) {
      const file = resolve(root, request.path);
      if (!file.startsWith(root + sep)) throw new Error('The requested file is outside the task repository.');
      await initialized;
      const uri = pathToFileURL(file).href;
      if (documents.has(uri)) await connection.sendNotification('textDocument/didClose', {textDocument: {uri}});
      documents.delete(uri);
      return {closed: true};
    }
    if (request.previousPath) {
      const oldFile = resolve(root, request.previousPath), newFile = resolve(root, request.path);
      if (![oldFile,newFile].every(file => file.startsWith(root + sep) && !file.slice(root.length + 1).split(sep).includes('.git'))) throw new Error('Invalid file-move notification.');
      await initialized;
      const oldUri = pathToFileURL(oldFile).href;
      if (documents.has(oldUri)) await connection.sendNotification('textDocument/didClose', {textDocument:{uri:oldUri}});
      documents.delete(oldUri);
      await connection.sendNotification('workspace/didRenameFiles', {files:[{oldUri,newUri:pathToFileURL(newFile).href}]});
    }
    const file = await realpath(resolve(root, request.path));
    if (!file.startsWith(root + sep) || file.slice(root.length + 1).split(sep).includes('.git')) throw new Error('The requested file is outside repository source files.');
    if ((await stat(file)).size > 1000000) throw new Error('File exceeds the language inspection limit.');
    const text = await readFile(file, 'utf8');
    if (Buffer.byteLength(text) > 1000000) throw new Error('File exceeds the language inspection limit.');
    const position = {line: request.line - 1, character: request.column - 1};
    const lines = text.split('\n');
    if (!Number.isInteger(position.line) || !Number.isInteger(position.character) || position.line < 0 || position.character < 0 || position.line >= lines.length || position.character > lines[position.line].length) throw new Error('Position is outside the file. Columns use UTF-16 units.');
    const methods = {code_actions: 'textDocument/codeAction', definition: 'textDocument/definition', references: 'textDocument/references', hover: 'textDocument/hover', rename_preview: 'textDocument/rename'};
    if (!['diagnostics','rename_file_preview'].includes(request.operation) && !methods[request.operation]) throw new Error('Unsupported language operation.');
    if (request.operation === 'rename_preview' && !request.newName) throw new Error('newName is required for a rename preview.');
    await initialized;
    const uri = pathToFileURL(file).href;
    const previous = documents.get(uri);
    const unchanged = previous?.text === text;
    const document = unchanged ? previous : {text, version: (previous?.version ?? 0) + 1, observed: false, diagnostics: [], truncated: false, resolve: null};
    if (!unchanged) {
      document.ready = new Promise(resolve => { document.resolve = resolve; });
      documents.set(uri, document);
      if (previous) await connection.sendNotification('textDocument/didChange', {textDocument: {uri, version: document.version}, contentChanges: [{text}]});
      else await connection.sendNotification('textDocument/didOpen', {textDocument: {uri, languageId: language, version: document.version, text}});
    }
    let result;
    if (request.operation === 'diagnostics') {
      const waitMs = request.diagnosticWaitMs ?? 15000;
      if (!Number.isInteger(waitMs) || waitMs < 0 || waitMs > 15000) throw new Error('Invalid diagnostics wait budget.');
      // Edit receipts poll current observations without waiting for an optional server push.
      // Explicit inspect_code diagnostics retain the full bounded observation wait.
      if (waitMs > 0 && !document.observed) {
        let timeout;
        try { await Promise.race([document.ready, new Promise(resolve => { timeout = setTimeout(resolve, waitMs); })]); }
        finally { clearTimeout(timeout); }
      }
      result = document.diagnostics;
    } else if (request.operation === 'code_actions') {
      const end = {line:(request.endLine ?? request.line) - 1, character:(request.endColumn ?? request.column) - 1};
      if (end.line < position.line || end.line >= lines.length || end.character < 0 || end.character > lines[end.line].length || (end.line === position.line && end.character < position.character)) throw new Error('Invalid action selection.');
      let actions = await connection.sendRequest('textDocument/codeAction', {textDocument:{uri}, range:{start:position, end}, context:{diagnostics:document.diagnostics, triggerKind:1, ...(request.kind ? {only:[request.kind]} : {})}}) ?? [];
      // Server data IDs may change between requests. Fence the fresh source and resolved edit, not opaque lookup IDs.
      if (serverCapabilities.codeActionProvider?.resolveProvider) {
        const resolved = [];
        for (const action of actions.slice(0,100)) resolved.push(action.command || action.disabled ? action : await connection.sendRequest('codeAction/resolve', action));
        actions = resolved;
      }
      const actionDigest = action => createHash('sha256').update(JSON.stringify([text,action.title,action.kind??null,action.edit??null,action.command??null,action.disabled??null])).digest('hex');
      if (request.actionIndex !== undefined) {
        let action = actions[request.actionIndex];
        if (!action || actionDigest(action) !== request.actionSha256) throw new Error('Code action changed; inspect available actions again.');
        if (action.disabled) throw new Error('The selected code action is disabled.');
        if (action.command || !action.edit) throw new Error('This action requires server commands or has no textual edits; it cannot be safely applied by the fenced editor.');
        result = action.edit;
      } else result = actions.slice(0,100).map((action,index) => ({index, title:action.title, kind:action.kind ?? null, sha256:actionDigest(action), disabled:action.disabled ?? null, requiresCommand:Boolean(action.command)}));
    } else if (request.operation === 'rename_file_preview') {
      if (!serverCapabilities.workspace?.fileOperations?.willRename) throw new Error('Language server does not support semantic file moves.');
      const destination = resolve(root, request.newPath);
      if (!destination.startsWith(root + sep) || destination.slice(root.length + 1).split(sep).includes('.git') || (await realpath(resolve(destination, '..'))) !== resolve(destination, '..')) throw new Error('Invalid move destination or parent symlink.');
      if (await lstat(destination).then(() => true, () => false)) throw new Error('Move destination already exists.');
      result = await connection.sendRequest('workspace/willRenameFiles', {files:[{oldUri:uri, newUri:pathToFileURL(destination).href}]}) ?? {changes:{}};
    } else result = await connection.sendRequest(methods[request.operation], {textDocument: {uri}, position, ...(request.operation === 'references' ? {context: {includeDeclaration: true}} : {}), ...(request.operation === 'rename_preview' ? {newName: request.newName} : {})});
    if (request.includeRenameSources) {
      if (!['rename_preview','rename_file_preview','code_actions'].includes(request.operation)) throw new Error('Source snapshots require a refactor request.');
      if (result?.changeAnnotations || (result?.changes && result?.documentChanges)) throw new Error('Unsupported or ambiguous workspace edit; no edits applied.');
      const changeMap = {...result?.changes};
      for (const edit of result?.documentChanges ?? []) {
        if (!edit.textDocument || !Array.isArray(edit.edits) || edit.kind) throw new Error('Resource operations are not allowed in server edits.');
        const targetUri = edit.textDocument.uri;
        const version = edit.textDocument.version;
        if (version !== null && version !== undefined && documents.get(targetUri)?.version !== version) throw new Error('Language edit version differs from inspected source.');
        if (changeMap[targetUri]) throw new Error('Duplicate workspace edit target.');
        changeMap[targetUri] = edit.edits;
      }
      if (request.operation === 'rename_file_preview' && !changeMap[uri]) changeMap[uri] = [];
      const changes = Object.entries(changeMap);
      if (!changes.length || changes.length > 8) throw new Error('Refactor must affect one to eight existing files.');
      let size = 0;
      const files = [];
      for (const [targetUri, edits] of changes) {
        const target = fileURLToPath(targetUri);
        const relative = target.slice(root.length + 1);
        if (!target.startsWith(root + sep) || relative.split(sep).includes('.git') || (await realpath(target)) !== target) throw new Error('Rename target escapes repository or traverses a symlink.');
        if ((await stat(target)).size > 200000) throw new Error('Rename source exceeds limit.');
        const content = await readFile(target, 'utf8');
        size += Buffer.byteLength(content);
        if (size > 200000 || !Array.isArray(edits) || edits.length > 500) throw new Error('Rename exceeds batch limit.');
        const open = documents.get(targetUri);
        if (open && open.text !== content) throw new Error('Open document changed since language inspection; request a fresh rename.');
        files.push({path: relative, content, sha256: createHash('sha256').update(content).digest('hex'), edits});
      }
      return {files};
    }
    let truncated = document.truncated;
    if (Array.isArray(result) && result.length > 100) { result = result.slice(0, 100); truncated = true; }
    if (JSON.stringify(result).length > 100000) throw new Error('Language result exceeds the limit; narrow the query. No edits were applied.');
    return {language, operation: request.operation, result, diagnosticsObserved: document.observed, truncated, serverId: process.pid};
  }
}
`;
