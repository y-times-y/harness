import { randomUUID } from "node:crypto";
import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { commandScopeRoot } from "./api-command-scope";
import { runGuestCapability } from "./guest-node-capability";
import { repositoryToolPath } from "./repository-tool-path";

const session = z.object({ debuggerId: z.string().uuid() });
const request = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("start"),
		path: repositoryToolPath,
		arguments: z.array(z.string().max(1000)).max(20).default([]),
	}),
	session.extend({
		action: z.literal("breakpoint"),
		path: repositoryToolPath,
		line: z.number().int().min(1),
		column: z.number().int().min(1).default(1),
	}),
	session.extend({
		action: z.literal("variables"),
		objectId: z.string().min(1).max(1000),
	}),
	session.extend({
		action: z.literal("remove_breakpoint"),
		breakpointId: z.string().min(1).max(2000),
	}),
	session.extend({
		action: z.enum([
			"continue",
			"pause",
			"step_over",
			"step_into",
			"step_out",
			"stack",
			"stop",
		]),
	}),
]);

export function nodeDebuggerTools(
	input: AgentToolWorkspaceInput & {
		ownerSessionId: string;
		turnId: string;
		signal: AbortSignal;
		once: (id: string, run: () => Promise<unknown>) => Promise<unknown>;
	},
): ToolSet {
	return {
		debug_node: tool({
			description:
				"Debug a dedicated Node process in this writable task VM. Start a repository JS/MJS/CJS entry, set 1-based breakpoints before continue, pause/step, inspect stack and returned local object IDs, then stop. No arbitrary evaluation or attachment to other processes. The process can execute application side effects; it is not a passing-test receipt. Sessions expire after five idle minutes. Unsupported runtimes require another debugger.",
			inputSchema: request,
			execute: (args, options) =>
				input.once(options.toolCallId, async () => {
					const workspace = await resolveToolWorkspace(input);
					return runGuestCapability(
						workspace,
						"debugger",
						NODE_DEBUGGER_SOURCE,
						{
							...args,
							cwd: workspace.cwd,
							ownerSessionId: input.ownerSessionId,
							commandScope: commandScopeRoot(input.turnId),
							debuggerId:
								args.action === "start" ? randomUUID() : args.debuggerId,
						},
						z.record(z.string(), z.json()),
						input.signal,
					);
				}),
		}),
	};
}

const DEBUGGER_WORKER = `
import { workerData, parentPort } from 'node:worker_threads';
import { Session } from 'node:inspector';
import { createRequire } from 'node:module';
import { createServer } from 'node:net';
import { realpath } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
const require = createRequire(workerData.packages + '/package.json');
const {createMessageConnection, StreamMessageReader, StreamMessageWriter} = require('vscode-jsonrpc/node');
const inspector = new Session();
inspector.connectToMainThread();
const post = (method, params = {}) => new Promise((resolve, reject) => inspector.post(method, params, (error, result) => error ? reject(error) : resolve(result)));
const scripts = new Map(), objects = new Set(), sockets = new Set();
let paused = null, started = false, ended = false, log = '', logTruncated = false, idle, serial = Promise.resolve();
const root = workerData.root;
const ownFile = async path => {
  const file = await realpath(resolve(root, path));
  if (!file.startsWith(root + sep) || file.slice(root.length + 1).split(sep).includes('.git')) throw new Error('Path must be repository source.');
  return file;
};
inspector.on('Debugger.scriptParsed', message => scripts.set(message.params.scriptId, message.params.url));
inspector.on('Debugger.paused', message => { paused = message.params; objects.clear(); });
inspector.on('Debugger.resumed', () => { paused = null; objects.clear(); });
parentPort.on('message', message => {
  if (message.kind === 'log') { logTruncated ||= log.length + message.text.length > 32000; log = (log + message.text).slice(-32000); }
  if (message.kind === 'ended') ended = true;
});
const stop = async () => {
  clearTimeout(idle);
  await post('Debugger.resume').catch(() => {});
  try { process.kill(-process.pid, 'SIGTERM'); } catch { process.kill(process.pid, 'SIGTERM'); }
};
const armIdle = () => { clearTimeout(idle); idle = setTimeout(stop, 300000); };
await post('Debugger.enable');
await post('Runtime.enable');
const stack = () => (paused?.callFrames ?? []).slice(0, 100).flatMap(frame => {
  const url = scripts.get(frame.location.scriptId);
  let file;
  try { file = fileURLToPath(url); } catch { return []; }
  if (!file.startsWith(root + sep)) return [];
  return [{ functionName: frame.functionName, path: file.slice(root.length + 1), line: frame.location.lineNumber + 1, column: frame.location.columnNumber + 1,
    scopes: frame.scopeChain.filter(scope => ['local','closure','block','catch','module'].includes(scope.type)).map(scope => { objects.add(scope.object.objectId); return {type: scope.type, objectId: scope.object.objectId}; }) }];
});
async function execute(input) {
  armIdle();
  if (input.action === 'stop') { setTimeout(stop, 30); return {stopped: true}; }
  if (input.action === 'remove_breakpoint') return await post('Debugger.removeBreakpoint', {breakpointId: input.breakpointId});
  if (input.action === 'breakpoint') {
    const file = await ownFile(input.path);
    return await post('Debugger.setBreakpointByUrl', {url: pathToFileURL(file).href, lineNumber: input.line - 1, columnNumber: input.column - 1});
  }
  if (input.action === 'variables') {
    if (!paused || !objects.has(input.objectId)) throw new Error('Object ID is not from the current paused stack.');
    const result = await post('Runtime.getProperties', {objectId: input.objectId, ownProperties: true, generatePreview: false});
    return {variables: result.result.slice(0, 100).map(property => {
      const value = property.value;
      if (value?.objectId) objects.add(value.objectId);
      return {name: property.name.slice(0, 1000), accessor: Boolean(property.get || property.set), truncated: property.name.length > 1000 || (value?.description?.length ?? 0) > 2000 || (typeof value?.value === 'string' && value.value.length > 2000), ...(value ? {type: value.type, value: typeof value.value === 'string' ? value.value.slice(0, 2000) : value.value ?? null, description: value.description?.slice(0, 2000) ?? null, objectId: value.objectId ?? null} : {})};
    }), truncated: result.result.length > 100};
  }
  if (input.action === 'continue' && !started) { started = true; parentPort.postMessage({kind: 'run'}); }
  else if (input.action !== 'stack') {
    const methods = {continue: 'Debugger.resume', pause: 'Debugger.pause', step_over: 'Debugger.stepOver', step_into: 'Debugger.stepInto', step_out: 'Debugger.stepOut'};
    if (!methods[input.action]) throw new Error('Unsupported debugger action.');
    await post(methods[input.action]);
  }
  // Inspector events arrive asynchronously; return running rather than inventing a pause.
  await new Promise(resolve => setTimeout(resolve, 100));
  return {status: paused ? 'paused' : ended ? 'entry_finished' : started ? 'running' : 'ready', reason: paused?.reason ?? null, frames: stack(), framesTruncated: (paused?.callFrames.length ?? 0) > 100, log, logTruncated};
}
const server = createServer(socket => {
  sockets.add(socket);
  socket.on('close', () => sockets.delete(socket));
  const rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
  rpc.onRequest('debug', input => {
    const operation = serial.then(() => execute(input));
    serial = operation.catch(() => {});
    return operation;
  });
  rpc.listen();
});
await new Promise((resolve, reject) => { server.once('error', reject); server.listen(workerData.socketPath, resolve); });
armIdle();
parentPort.postMessage({kind: 'ready'});
`;

export const NODE_DEBUGGER_SOURCE = String.raw`
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
const startTick=async(pid)=>{try{const stat=await readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[19];}catch{const shown=spawnSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).stdout.trim();if(!shown)throw new Error('Missing owned process identity.');return shown;}};
import { Worker } from 'node:worker_threads';
import { mkdir, lstat, realpath, unlink, readFile, writeFile, rename, access } from 'node:fs/promises';
import { resolve, sep, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createConnection } from 'node:net';
const input = JSON.parse(process.argv[2]);
if (!/^[a-f0-9-]{36}$/.test(input.debuggerId) || typeof input.ownerSessionId !== 'string') throw new Error('Invalid debugger ownership.');
const root = await realpath(input.cwd);
const key = createHash('sha256').update(JSON.stringify([root, input.ownerSessionId, input.debuggerId])).digest('hex').slice(0, 24);
const directory = '/tmp/yt-debug-' + process.getuid() + '-' + key;
const socketPath = join(directory, 'rpc');
if (input.daemon) {
  const worker = new Worker(new URL('data:text/javascript;base64,' + Buffer.from(${JSON.stringify(DEBUGGER_WORKER)}).toString('base64')), {workerData: {root, packages: process.argv[1], socketPath}});
  worker.on('error', () => process.exit(1));
  worker.on('exit', () => process.exit());
  process.on('SIGTERM', () => { void unlink(socketPath).finally(() => process.exit()); });
  for (const stream of [process.stdout, process.stderr]) stream.write = (chunk, encoding, callback) => { worker.postMessage({kind: 'log', text: String(chunk)}); if(typeof encoding === 'function') encoding(); else callback?.(); return true; };
  worker.on('message', async message => {
    if (message.kind !== 'run') return;
    try { process.argv = [process.execPath, input.entry, ...(input.arguments ?? [])]; await import(pathToFileURL(input.entry).href); }
    catch(error) { worker.postMessage({kind: 'log', text: String(error?.stack ?? error)}); }
    finally { worker.postMessage({kind: 'ended'}); }
  });
} else {
  const require = createRequire(process.argv[1] + '/package.json');
  const {createMessageConnection, StreamMessageReader, StreamMessageWriter} = require('vscode-jsonrpc/node');
  if (input.action === 'start') {
    const entry = await realpath(resolve(root, input.path));
    if (!entry.startsWith(root + sep) || entry.slice(root.length + 1).split(sep).includes('.git') || !/\.(?:js|mjs|cjs)$/.test(entry)) throw new Error('Start requires a repository JS/MJS/CJS file.');
    await mkdir(directory, {mode: 0o700});
    if (input.commandScope) {
      await mkdir(input.commandScope, {recursive: true});
      const scopeInfo = await lstat(input.commandScope);
      if(!scopeInfo.isDirectory() || scopeInfo.uid !== process.getuid()) throw new Error('Unsafe command scope.');
      if(await access(join(input.commandScope, 'stopped')).then(() => true, () => false)) throw new Error('This turn is already fenced.');
    }
    const daemon = spawn(process.execPath, [...process.execArgv, process.argv[1], JSON.stringify({...input, entry, daemon: true})], {cwd: root, detached: true, stdio: 'ignore'});
    daemon.unref();
    if(input.commandScope) {
      try {
        const start = await startTick(daemon.pid);
        const record = join(input.commandScope, input.debuggerId + '.json');
        await writeFile(record + '.tmp', JSON.stringify({pid: daemon.pid, start}), {mode: 0o600});
        await rename(record + '.tmp', record);
        if(await access(join(input.commandScope, 'stopped')).then(() => true, () => false)) throw new Error('This turn was fenced during debugger launch.');
      } catch(error) { try { process.kill(-daemon.pid, 'SIGKILL'); } catch {} throw error; }
    }
  }
  const info = await lstat(directory);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o777) !== 0o700) throw new Error('Unsafe debugger directory.');
  let socket;
  const deadline = Date.now() + (input.action === 'start' ? 10000 : 1000);
  while (!socket) {
    try { socket = await new Promise((resolve, reject) => { const stream = createConnection(socketPath); stream.once('error', error => {stream.destroy(); reject(error);}); stream.once('connect', () => {stream.removeAllListeners('error'); resolve(stream);}); }); }
    catch(error) { if(Date.now() > deadline) throw new Error('Debugger unavailable; its process may have exited. Do not replay start without inspecting the prior outcome.'); await new Promise(resolve => setTimeout(resolve, 50)); }
  }
  const rpc = createMessageConnection(new StreamMessageReader(socket), new StreamMessageWriter(socket));
  rpc.listen();
  let timeout;
  try {
    const result = await Promise.race([rpc.sendRequest('debug', {...input, action: input.action === 'start' ? 'stack' : input.action}), new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('Debugger request timed out.')), 10000); })]);
    console.log(JSON.stringify({debuggerId: input.debuggerId, ...result}));
  } finally { clearTimeout(timeout); rpc.dispose(); socket.destroy(); }
}
`;
