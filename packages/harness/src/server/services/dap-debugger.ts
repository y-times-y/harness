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
const breakpointFile = z.object({
	path: repositoryToolPath,
	lines: z.array(z.number().int().min(1)).max(40),
});
const request = z.discriminatedUnion("action", [
	z.object({
		action: z.literal("start"),
		adapter: z.enum(["python", "go", "lldb", "gdb", "dotnet", "configured"]),
		path: repositoryToolPath,
		arguments: z.array(z.string().max(1000)).max(20).default([]),
		breakpoints: z.array(breakpointFile).max(10).default([]),
		configuration: z.string().min(1).max(100).optional(),
	}),
	session.extend({ action: z.literal("breakpoints"), ...breakpointFile.shape }),
	session.extend({
		action: z.literal("scopes"),
		frameId: z.number().int().nonnegative(),
		pauseId: z.string().uuid(),
	}),
	session.extend({
		action: z.literal("variables"),
		reference: z.number().int().positive(),
		pauseId: z.string().uuid(),
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

export function dapDebuggerTools(
	input: AgentToolWorkspaceInput & {
		ownerSessionId: string;
		turnId: string;
		signal: AbortSignal;
		once: (id: string, work: () => Promise<unknown>) => Promise<unknown>;
	},
): ToolSet {
	return {
		debug_program: tool({
			description:
				"Launch and debug an owned program using standard DAP: Python/debugpy, Go/Delve, LLDB, GDB or .NET/netcoredbg. Configured stdio adapters come from repository .ytimesy-debuggers.json. Prepare runtime tooling first. Start can supply breakpoints; later breakpoints replaces that file's complete set. Inspect stack, then scopes and variables using the returned pauseId; old pause references are rejected. No evaluation, process attachment or external source reads. Application side effects are possible. Stop sessions explicitly; idle sessions expire after five minutes.",
			inputSchema: request,
			execute: (args, options) =>
				input.once(options.toolCallId, async () => {
					const workspace = await resolveToolWorkspace(input);
					return runGuestCapability(
						workspace,
						"debugger",
						DAP_DEBUGGER_SOURCE,
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

export const DAP_DEBUGGER_SOURCE = String.raw`
import {createRequire} from 'node:module';
import {createHash,randomUUID} from 'node:crypto';
import {spawn,spawnSync} from 'node:child_process';
const startTick=async(pid)=>{try{const stat=await readFile('/proc/'+pid+'/stat','utf8');return stat.slice(stat.lastIndexOf(')')+1).trim().split(/\s+/)[19];}catch{const shown=spawnSync('ps',['-o','lstart=','-p',String(pid)],{encoding:'utf8',env:{...process.env,LC_ALL:'C'}}).stdout.trim();if(!shown)throw new Error('Missing owned process identity.');return shown;}};
import {mkdir,lstat,realpath,readFile,writeFile,rename,access,unlink} from 'node:fs/promises';
import {resolve,sep,join} from 'node:path';
import {createConnection,createServer} from 'node:net';
const input=JSON.parse(process.argv[2]);
if(!/^[a-f0-9-]{36}$/.test(input.debuggerId)||typeof input.ownerSessionId!=='string')throw new Error('Invalid debugger ownership.');
const root=await realpath(input.cwd);
const key=createHash('sha256').update(JSON.stringify([root,input.ownerSessionId,input.debuggerId,'dap-v1'])).digest('hex').slice(0,24);
const directory='/tmp/yt-dap-'+process.getuid()+'-'+key, socketPath=join(directory,'rpc');
const require=createRequire(process.argv[1]+'/package.json');
const {createMessageConnection,StreamMessageReader,StreamMessageWriter}=require('vscode-jsonrpc/node');
const rpc=socket=>createMessageConnection(new StreamMessageReader(socket),new StreamMessageWriter(socket));
const ownFile=async path=>{
  const requested=resolve(root,path),file=await realpath(requested);
  if(!file.startsWith(root+sep)||file.slice(root.length+1).split(sep).includes('.git')||file!==requested||!(await lstat(file)).isFile())throw new Error('Debugger path must be a repository file without symlinks.');
  return file;
};
if(input.daemon){
  const {ProtocolClient}=require('@vscode/debugadapter-testsupport/lib/protocolClient');
  class AdapterClient extends ProtocolClient {bind(reader,writer){this.connect(reader,writer);}}
  const client=new AdapterClient();
  const definitions={
    python:{command:input.python??process.argv[1]+'/python/bin/python',args:['-m','debugpy.adapter'],launch:{justMyCode:false,stopOnEntry:true}},
    go:{command:process.argv[1]+'/bin/dlv',args:['dap','--listen=127.0.0.1:0'],tcp:true,launch:{mode:'debug',stopOnEntry:true}},
    lldb:{command:'lldb-dap',args:[],launch:{stopOnEntry:true}},
    gdb:{command:'gdb',args:['-i','dap'],launch:{stopAtBeginningOfMainSubprogram:true}},
    dotnet:{command:'netcoredbg',args:['--interpreter=vscode'],launch:{stopAtEntry:true}}
  };
  if(input.adapter==='configured'){
    const configFile=await ownFile('.ytimesy-debuggers.json');
    if((await lstat(configFile)).size>32000)throw new Error('Debugger configuration is oversized.');
    const config=JSON.parse(await readFile(configFile,'utf8'))[input.configuration];
    if(!config||typeof config.command!=='string'||config.command.length>1000||!Array.isArray(config.args)||config.args.length>20||config.args.some(arg=>typeof arg!=='string'||arg.length>1000))throw new Error('Invalid configured stdio debugger.');
    definitions.configured={command:config.command,args:config.args,launch:config.launch??{}};
  }
  const definition=definitions[input.adapter];
  if(!definition)throw new Error('Unknown debugger adapter.');
  const child=spawn(definition.command,definition.args,{cwd:root,stdio:['pipe','pipe','pipe']});
  let log='',logTruncated=false,threadId=null,pauseId=null,ended=false,idle,closing=false,serial=Promise.resolve();
  const frameIds=new Set(),references=new Set(),sockets=new Set();
  const capture=text=>{logTruncated ||= log.length+text.length>32000;log=(log+text).slice(-32000);};
  const resetPause=()=>{pauseId=null;frameIds.clear();references.clear();};
  async function shutdown(){
    if(closing)return;closing=true;clearTimeout(idle);
    await Promise.race([client.send('disconnect',{terminateDebuggee:true}),new Promise(resolve=>setTimeout(resolve,500))]).catch(()=>{});
    for(const socket of sockets)socket.destroy();
    await unlink(socketPath).catch(()=>{});
    try{process.kill(-process.pid,'SIGTERM');}catch{process.kill(process.pid,'SIGTERM');}
  }
  const armIdle=()=>{clearTimeout(idle);idle=setTimeout(shutdown,300000);};
  process.on('SIGTERM',()=>{child.kill('SIGKILL');void unlink(socketPath).finally(()=>process.exit());});
  process.on('uncaughtException',()=>void shutdown());
  child.on('error',()=>void shutdown());
  child.on('exit',()=>{ended=true;resetPause();});
  client.on('stopped',event=>{threadId=event.body.threadId??threadId;pauseId=randomUUID();frameIds.clear();references.clear();});
  client.on('continued',resetPause);
  client.on('terminated',()=>{ended=true;resetPause();});
  client.on('output',event=>capture(String(event.body?.output??'')));
  let initializedResolve;
  const initialized=new Promise(resolve=>{initializedResolve=resolve;});
  client.on('initialized',initializedResolve);
  async function connectAdapter(){
    if(!definition.tcp){client.bind(child.stdout,child.stdin);child.stderr.on('data',data=>capture(String(data)));return;}
    let addressResolve;
    const address=new Promise(resolve=>{addressResolve=resolve;});
    const observe=data=>{capture(String(data));const match=log.match(/DAP server listening at: (127\.0\.0\.1):(\d+)/);if(match)addressResolve(Number(match[2]));};
    child.stdout.on('data',observe);child.stderr.on('data',observe);
    let timer;
    try{
      const port=await Promise.race([address,new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Owned adapter TCP startup timed out.')),10000);})]);
      const stream=await new Promise((resolve,reject)=>{const socket=createConnection({host:'127.0.0.1',port});socket.once('error',reject);socket.once('connect',()=>resolve(socket));});
      client.bind(stream,stream);
    }finally{clearTimeout(timer);}
  }
  const setBreakpoints=async file=>client.send('setBreakpoints',{source:{path:await ownFile(file.path)},breakpoints:file.lines.map(line=>({line})),sourceModified:false});
  const ready=(async()=>{
    await connectAdapter();
    const capabilities=await client.send('initialize',{clientID:'ytimesy',adapterID:input.adapter,pathFormat:'path',linesStartAt1:true,columnsStartAt1:true,supportsRunInTerminalRequest:false,supportsVariableType:true,supportsVariablePaging:true});
    const launched=client.send('launch',{...definition.launch,program:input.entry,args:input.arguments??[],cwd:root,request:'launch',console:'internalConsole'});
    await initialized;
    const breakpoints=[];
    for(const file of input.breakpoints??[])breakpoints.push((await setBreakpoints(file)).body);
    if(capabilities.body?.supportsConfigurationDoneRequest)await client.send('configurationDone',{});
    await launched;
    return breakpoints;
  })();
  ready.catch(()=>void shutdown());
  async function snapshot(){
    let frames=[];
    if(pauseId&&threadId){
      const stack=await client.send('stackTrace',{threadId,startFrame:0,levels:100});
      frames=(stack.body?.stackFrames??[]).flatMap(frame=>{
        const path=frame.source?.path;
        if(typeof path!=='string'||!path.startsWith(root+sep)||path.slice(root.length+1).split(sep).includes('.git'))return[];
        frameIds.add(frame.id);return[{id:frame.id,name:String(frame.name).slice(0,1000),path:path.slice(root.length+1),line:frame.line,column:frame.column}];
      });
    }
    return {status:ended?'finished':pauseId?'paused':'running',threadId,pauseId,frames,log,logTruncated};
  }
  async function execute(request){
    armIdle();
    if(request.action==='stop'){setTimeout(shutdown,30);return{stopped:true};}
    await ready;
    if(request.action==='breakpoints')return (await setBreakpoints(request)).body??{};
    if(['scopes','variables'].includes(request.action)){
      if(!pauseId||request.pauseId!==pauseId)throw new Error('Reference belongs to another paused state.');
      if(request.action==='scopes'){
        if(!frameIds.has(request.frameId))throw new Error('Frame was not returned in this paused stack.');
        const result=await client.send('scopes',{frameId:request.frameId});
        return{pauseId,scopes:(result.body?.scopes??[]).slice(0,30).map(scope=>{references.add(scope.variablesReference);return{name:String(scope.name).slice(0,1000),reference:scope.variablesReference,expensive:Boolean(scope.expensive)};})};
      }
      if(!references.has(request.reference))throw new Error('Variable reference was not returned for this pause.');
      const result=await client.send('variables',{variablesReference:request.reference,start:0,count:100});
      const variables=result.body?.variables??[];
      return{pauseId,truncated:variables.length>100,variables:variables.slice(0,100).map(variable=>{if(variable.variablesReference)references.add(variable.variablesReference);return{name:String(variable.name).slice(0,1000),value:String(variable.value).slice(0,2000),type:variable.type??null,reference:variable.variablesReference??0};})};
    }
    const methods={continue:'continue',pause:'pause',step_over:'next',step_into:'stepIn',step_out:'stepOut'};
    if(methods[request.action]){
      if(!threadId){const threads=await client.send('threads');threadId=threads.body?.threads?.[0]?.id;}
      if(!threadId)throw new Error('No owned debugger thread is available.');
      if(request.action!=='pause')resetPause();
      await client.send(methods[request.action],{threadId});
    }else if(request.action!=='stack')throw new Error('Unsupported debugger action.');
    await new Promise(resolve=>setTimeout(resolve,100));
    return snapshot();
  }
  const server=createServer(socket=>{
    sockets.add(socket);socket.on('close',()=>sockets.delete(socket));
    const connection=rpc(socket);
    connection.onRequest('debug',request=>{
      const operation=serial.then(async()=>{let timer;try{return await Promise.race([execute(request),new Promise((_,reject)=>{timer=setTimeout(()=>{reject(new Error('Adapter stalled; session stopped.'));void shutdown();},20000);})]);}finally{clearTimeout(timer);}});
      serial=operation.catch(()=>{});return operation;
    });connection.listen();
  });
  await new Promise((resolve,reject)=>{server.once('error',reject);server.listen(socketPath,resolve);});
  armIdle();
}else{
  if(input.action==='start'){
    const entry=await ownFile(input.path);
    for(const file of input.breakpoints??[])await ownFile(file.path);
    await mkdir(directory,{mode:0o700});
    if(input.commandScope){await mkdir(input.commandScope,{recursive:true});const info=await lstat(input.commandScope);if(!info.isDirectory()||info.uid!==process.getuid()||await access(join(input.commandScope,'stopped')).then(()=>true,()=>false))throw new Error('Turn is fenced or command scope unsafe.');}
    const daemon=spawn(process.execPath,[...process.execArgv,process.argv[1],JSON.stringify({...input,entry,daemon:true})],{cwd:root,detached:true,stdio:'ignore'});daemon.unref();
    if(input.commandScope){try{const start=await startTick(daemon.pid);const file=join(input.commandScope,input.debuggerId+'.json');await writeFile(file+'.tmp',JSON.stringify({pid:daemon.pid,start}),{mode:0o600});await rename(file+'.tmp',file);if(await access(join(input.commandScope,'stopped')).then(()=>true,()=>false))throw new Error('Turn fenced during launch.');}catch(error){try{process.kill(-daemon.pid,'SIGKILL');}catch{}throw error;}}
  }
  const info=await lstat(directory);
  if(!info.isDirectory()||info.uid!==process.getuid()||(info.mode&0o777)!==0o700)throw new Error('Unsafe debugger directory.');
  let socket;const deadline=Date.now()+(input.action==='start'?10000:1000);
  while(!socket){try{socket=await new Promise((resolve,reject)=>{const stream=createConnection(socketPath);stream.once('error',error=>{stream.destroy();reject(error);});stream.once('connect',()=>{stream.removeAllListeners('error');resolve(stream);});});}catch(error){if(Date.now()>deadline)throw new Error('Owned debugger unavailable. Inspect prior outcomes before retrying.');await new Promise(resolve=>setTimeout(resolve,50));}}
  const connection=rpc(socket);connection.listen();let timer;
  try{const result=await Promise.race([connection.sendRequest('debug',{...input,action:input.action==='start'?'stack':input.action}),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Debugger response timed out; inspect outcome.')),25000);})]);console.log(JSON.stringify({debuggerId:input.debuggerId,...result}));}
  finally{clearTimeout(timer);connection.dispose();socket.destroy();}
}
`;
