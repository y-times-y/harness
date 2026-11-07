import { randomUUID } from "node:crypto";
import { posixShellCommand } from "../../domain/posix-command";
import { SOURCE_AGENT_SECRETS } from "../../domain/project-secret";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

/**
 * The process's start time, so a recycled pid is never mistaken for it:
 * /proc's start tick on Linux; elsewhere (macOS) ps's lstart text. That text
 * (for example "Fri Nov  6 10:09:11 2026") is only compared for equality, never
 * parsed; LC_ALL=C pins its language and format. Where ps cannot be run at all
 * (not installed, not permitted) the answer is "unknown": the command still
 * runs and can still be stopped, only without recycled-pid protection.
 */
export const START_TICK = `def start_tick(pid):
    try: return pathlib.Path('/proc/'+str(pid)+'/stat').read_text().rsplit(')',1)[1].split()[19]
    except OSError:
        try: shown=subprocess.run(['ps','-o','lstart=','-p',str(pid)],capture_output=True,text=True,env={**os.environ,'LC_ALL':'C'}).stdout.strip()
        except OSError: return 'unknown'
        if not shown: raise ProcessLookupError(pid)
        return shown`;

const RUN = `import base64, json, os, pathlib, signal, subprocess, sys
root=pathlib.Path(sys.argv[1]); root.mkdir(parents=True,exist_ok=True)
if (root/'stopped').exists() or (root/(sys.argv[2]+'.stopped')).exists(): sys.exit(130)
record=root/(sys.argv[2]+'.json')
environment=os.environ.copy()
environment.pop('FORCE_COLOR',None)
environment['NO_COLOR']='1'
environment['TERM']='dumb'
${START_TICK}
process=subprocess.Popen(['bash','-lc',base64.b64decode(sys.argv[4]).decode('utf-8')],cwd=sys.argv[3],env=environment,start_new_session=True)
tick=start_tick(process.pid)
temporary=record.with_suffix('.tmp')
temporary.write_text(json.dumps({'pid':process.pid,'start':tick})); temporary.replace(record)
def stop(*_):
    try: os.killpg(process.pid,signal.SIGTERM)
    except (ProcessLookupError,PermissionError): pass
    try: process.wait(timeout=2)
    except subprocess.TimeoutExpired:
        try: os.killpg(process.pid,signal.SIGKILL)
        except (ProcessLookupError,PermissionError): pass
        process.wait()
signal.signal(signal.SIGTERM,stop); signal.signal(signal.SIGHUP,stop)
if (root/'stopped').exists() or (root/(sys.argv[2]+'.stopped')).exists(): stop()
try:
    try: result=process.wait(timeout=int(sys.argv[5]))
    except subprocess.TimeoutExpired: stop(); result=124
finally:
    try: os.killpg(process.pid,signal.SIGKILL)
    except (ProcessLookupError,PermissionError): pass
    record.unlink(missing_ok=True)
sys.exit(result if result>=0 else 128-result)`;

/**
 * Stops the recorded process group of one command (argv: scope root, command
 * id) or of every command in the scope (argv: scope root).
 */
export const COMMAND_STOP_SCRIPT = `import json, os, pathlib, signal, subprocess, sys, time
${START_TICK}
root=pathlib.Path(sys.argv[1])
root.mkdir(parents=True,exist_ok=True)
command = sys.argv[2] if len(sys.argv)>2 else None
(root/(command+'.stopped' if command else 'stopped')).touch()
targets=[]
for record in ([root/(command+'.json')] if command else root.glob('*.json')):
    try:
        saved=json.loads(record.read_text()); pid=int(saved['pid'])
        tick=start_tick(pid)
        if pid>1 and os.getpgid(pid)==pid and tick==saved['start']:
            targets.append(pid); os.killpg(pid,signal.SIGTERM)
    except (FileNotFoundError,ProcessLookupError,PermissionError): pass
deadline=time.monotonic()+2
while targets and time.monotonic()<deadline:
    alive=[]
    for pid in targets:
        try: os.killpg(pid,0); alive.append(pid)
        except (ProcessLookupError,PermissionError): pass
    targets=alive
    if targets: time.sleep(.05)
for pid in targets:
    try: os.killpg(pid,signal.SIGKILL)
    except (ProcessLookupError,PermissionError): pass`;

/** One scope directory per turn under here, holding `<command id>.json` process records. */
export const COMMAND_SCOPES_DIRECTORY = "/tmp/ytimesy-api-command-scopes";

export function commandScopeRoot(turnId: string) {
	if (!/^[a-zA-Z0-9-]{1,80}$/.test(turnId))
		throw new Error("Invalid command scope.");
	return `${COMMAND_SCOPES_DIRECTORY}/${turnId}`;
}
/**
 * The scope of a session's background commands: unlike a turn's scope it is
 * not stopped when a turn ends, so they keep running until they exit, are
 * stopped, the machine stops, or their own time limit ends them.
 */
export function backgroundCommandScope(sessionId: string) {
	return `bg-${sessionId.replaceAll(/[^a-zA-Z0-9-]/g, "").slice(0, 64)}`;
}

/** The longest a background command runs: YTIMESY_BACKGROUND_COMMAND_MAX_SECONDS, default six hours. */
export function backgroundCommandMaxSeconds() {
	const configured = Number(process.env.YTIMESY_BACKGROUND_COMMAND_MAX_SECONDS);
	return Number.isFinite(configured) && configured > 0
		? Math.min(86_400, Math.max(600, Math.round(configured)))
		: 6 * 60 * 60;
}

export function scopedShellCommand(input: {
	turnId: string;
	cwd: string;
	command: string;
	seconds: number;
	commandId?: string;
}) {
	if (input.commandId) commandScopeRoot(input.commandId);
	return posixShellCommand([
		"python3",
		"-c",
		RUN,
		commandScopeRoot(input.turnId),
		input.commandId ?? randomUUID(),
		input.cwd,
		// Base64 has no quotes: each shell layer around this (tmux, bash -lc,
		// docker exec) then adds a constant instead of multiplying every quote
		// in the agent's script. Quote-heavy 3 KB heredocs used to exceed the
		// VM exec limit (64 KiB) and were rejected.
		// Every agent command sees the project's environment variables and
		// runtime secrets; the turn redacts runtime values from its output.
		Buffer.from(`${SOURCE_AGENT_SECRETS}\n${input.command}`, "utf8").toString(
			"base64",
		),
		String(input.seconds),
	]);
}

/** Cancel one recorded process group, fenced by its Linux PID start time. */
export async function stopApiCommand(
	workspace: AgentToolWorkspace,
	turnId: string,
	commandId: string,
) {
	commandScopeRoot(commandId);
	const result = await workspace.machines.exec(
		workspace.vm,
		posixShellCommand([
			"python3",
			"-c",
			COMMAND_STOP_SCRIPT,
			commandScopeRoot(turnId),
			commandId,
		]),
		10000,
	);
	if (result.exitCode !== 0)
		throw new Error("Could not confirm cancellation of this owned command.");
}
export async function stopApiTurnCommands(
	workspace: AgentToolWorkspace,
	turnId: string,
) {
	const result = await workspace.machines.exec(
		workspace.vm,
		posixShellCommand([
			"python3",
			"-c",
			COMMAND_STOP_SCRIPT,
			commandScopeRoot(turnId),
		]),
		10_000,
	);
	if (result.exitCode !== 0)
		throw new Error("Could not confirm cancellation of owned commands.");
}
