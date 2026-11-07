import { type ToolSet, tool } from "ai";
import { z } from "zod";
import {
	type AgentToolWorkspaceInput,
	resolveToolWorkspace,
} from "./agent-tool-workspace";
import { guestCapabilityCommand } from "./guest-node-capability";

const request = z.object({
	runtime: z.enum(["python", "go", "rust"]),
	debugger: z.boolean().default(false),
});

export function codeToolingTools(
	input: AgentToolWorkspaceInput & {
		signal: AbortSignal;
		once: (id: string, work: () => Promise<unknown>) => Promise<unknown>;
	},
): ToolSet {
	return {
		prepare_code_tools: tool({
			description:
				"Prepare pinned Python, Go or Rust language tooling outside the repository in this VM. Python uses pyright; Go installs gopls v0.21.0 and requires Go; Rust downloads checksum-pinned rust-analyzer 2026-10-05 for Linux x64/arm64 and requires the project's Rust toolchain. debugger=true also prepares debugpy 1.8.20 in a guest virtualenv or Delve v1.27.2; Rust native debugging requires an installed LLDB/GDB adapter. Reports observed executable versions. May download dependencies and consume setup time; it does not modify project manifests or prove project checks passed.",
			inputSchema: request,
			execute: (args, options) =>
				input.once(options.toolCallId, async () => {
					const workspace = await resolveToolWorkspace(input);
					const capabilities = (
						args.debugger ? ["language", "debugger"] : ["language"]
					) as ("language" | "debugger")[];
					const prepared = [];
					for (const capability of capabilities) {
						input.signal.throwIfAborted();
						const result = await workspace.machines.exec(
							workspace.vm,
							guestCapabilityCommand(
								capability,
								CODE_TOOLING_SOURCE,
								{ runtime: args.runtime, debugger: capability === "debugger" },
								{ timeoutSeconds: 160 },
							),
							180000,
						);
						if (result.exitCode)
							throw new Error(
								`Runtime preparation failed: ${result.stderr.slice(-1200)}`,
							);
						prepared.push(
							z.record(z.string(), z.json()).parse(JSON.parse(result.stdout)),
						);
					}
					return { prepared };
				}),
		}),
	};
}

const CODE_TOOLING_SOURCE = `
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdir,writeFile,rename,chmod,access} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {gunzipSync} from 'node:zlib';
const run=promisify(execFile), input=JSON.parse(process.argv[2]), root=process.argv[1];
const bin=root+'/bin';
await mkdir(bin,{recursive:true,mode:0o700});
const execute=(command,args)=>run(command,args,{cwd:root,env:{...process.env,GOBIN:bin,GOWORK:'off'},timeout:140000,maxBuffer:100000});
let executable,version;
if(input.runtime==='python'){
  if(input.debugger){
    executable=root+'/python/bin/python';
    // Serialized setup prevents concurrent callers from partially replacing a virtualenv.
    await execute('flock',['-w','145',root+'/python-install.lock','sh','-c',
      'if ! test -x "$1/python/bin/python"; then python3 -m venv "$1/python"; fi; "$1/python/bin/python" -m pip install --only-binary=:all: --disable-pip-version-check --no-input debugpy==1.8.20 >&2','sh',root]);
    version=(await execute(executable,['-c','import debugpy; print(debugpy.__version__)'])).stdout.trim();
  }else{executable=root+'/node_modules/.bin/pyright-langserver';version=(await execute(root+'/node_modules/.bin/pyright',['--version'])).stdout.trim();}
}else if(input.runtime==='go'){
  const name=input.debugger?'dlv':'gopls', pinned=input.debugger?'github.com/go-delve/delve/cmd/dlv@v1.27.2':'golang.org/x/tools/gopls@v0.21.0';
  executable=bin+'/'+name;
  await execute('go',['version']);
  await execute('flock',['-w','145',root+'/'+name+'-install.lock','sh','-c','if ! test -x "$1"; then go install "$2" >&2; fi','sh',executable,pinned]);
  version=(await execute(executable,['version'])).stdout.trim();
}else if(input.runtime==='rust'){
  if(input.debugger){console.log(JSON.stringify({runtime:'rust',debugger:true,available:false,instruction:'Install lldb-dap or DAP-capable GDB through the environment recipe; prepare_code_tools does not install system packages.'}));process.exit(0);}
  if(process.platform!=='linux'||!['x64','arm64'].includes(process.arch))throw new Error('Pinned Rust server assets support Linux x64/arm64.');
  executable=bin+'/rust-analyzer';
  if(!await access(executable).then(()=>true,()=>false)){
    const assets={x64:{name:'x86_64',sha256:'28070188df63b6f217768040781decc8db43bc9d29b126847acb365575b09bc9'},arm64:{name:'aarch64',sha256:'3974c863acbbd96ef2cc02a7aaa79123935b05f27ffe4fd393fc229522f75cb9'}};
    const asset=assets[process.arch];
    const response=await fetch('https://github.com/rust-lang/rust-analyzer/releases/download/2026-10-05/rust-analyzer-'+asset.name+'-unknown-linux-gnu.gz',{signal:AbortSignal.timeout(60000)});
    if(!response.ok||Number(response.headers.get('content-length'))>60000000)throw new Error('Rust server asset unavailable or oversized.');
    const buffer=Buffer.from(await response.arrayBuffer());
    if(buffer.length>60000000||createHash('sha256').update(buffer).digest('hex')!==asset.sha256)throw new Error('Rust server asset checksum mismatch.');
    const temporary=executable+'.'+process.pid+'.tmp';
    await writeFile(temporary,gunzipSync(buffer,{maxOutputLength:200000000}),{mode:0o700});await chmod(temporary,0o700);await rename(temporary,executable);
  }
  version=(await execute(executable,['--version'])).stdout.trim();
}else throw new Error('Unsupported runtime.');
console.log(JSON.stringify({runtime:input.runtime,debugger:input.debugger,available:true,executable,version}));
`;
