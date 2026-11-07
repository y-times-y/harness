import { type ToolSet, tool } from "ai";
import { z } from "zod";
import { posixShellQuoted } from "../../domain/posix-command";

/**
 * Runs a deliverable the way a third party would: from a fresh copy holding
 * only what is delivered (Git-tracked files plus the declared outputs), with a
 * cleared environment, optionally as an unprivileged user, within a time
 * limit. It reports files and modules the run needed but the copy lacks, so a
 * deliverable that only works because of scratch data, caches, a workspace
 * virtualenv or ambient state is caught before the agent says it is done.
 * With tracked:false (the task names its outputs), a declared data file that
 * a delivered file reads at run time is reported too unless it is listed in
 * namedData: the grader receives only what the task names, so data the agent
 * added to `files` on its own passes here and is missing there.
 *
 * Arguments: base64 JSON {files, command, tracked, inputs, namedData,
 * unprivileged, timeoutSeconds, keepEnv}. Prints one JSON report; exits 0 even when the
 * deliverable fails (the report says so), 2 on a usage error.
 */
export const DELIVERABLE_CHECK_SOURCE = String.raw`import ast,base64,json,os,re,shutil,signal,subprocess,sys,tempfile,time
args=json.loads(base64.b64decode(sys.argv[1]))
root=os.path.realpath(args.get('cwd') or os.getcwd())
aliases=sorted({root}|{os.path.abspath(item) for item in (args.get('cwd'),os.environ.get('PWD')) if item and os.path.realpath(item)==root},key=len,reverse=True)
command=args['command']; limit=int(args.get('timeoutSeconds',120))
CACHE={'.git','__pycache__','node_modules','.venv','venv','.pytest_cache','.mypy_cache','.ruff_cache','.tox','.cache','.next','.turbo','.gradle','target'}
MAX_FILES=20000; MAX_BYTES=1<<30
def fail(message):
    print(json.dumps({'ok':False,'error':message})); sys.exit(2)
def inside(path):
    full=os.path.realpath(path if os.path.isabs(path) else os.path.join(root,path))
    if full!=root and not full.startswith(root+os.sep): fail('Only paths inside the workspace can be delivered: '+path)
    return os.path.relpath(full,root)
def walk(rel):
    full=os.path.join(root,rel)
    if os.path.islink(full) or os.path.isfile(full): return [rel]
    if not os.path.isdir(full): return None
    found=[]
    for directory,subdirectories,names in os.walk(full):
        subdirectories[:]=[name for name in subdirectories if name not in CACHE]
        found+= [os.path.relpath(os.path.join(directory,name),root) for name in names if not name.endswith('.pyc')]
    return found
selected={}; problems=[]; warnings=[]
# Only the listed files are delivered: the task names its outputs (tracked:false) or there is no Git checkout.
listed_only=not args.get('tracked',True)
if args.get('tracked',True):
    listed=subprocess.run(['git','-C',root,'ls-files','-z','--cached'],capture_output=True)
    if listed.returncode==0:
        for rel in listed.stdout.decode('utf-8','replace').split('\0'):
            if rel and os.path.lexists(os.path.join(root,rel)): selected[rel]='tracked'
    else:
        listed_only=True
        warnings.append('The workspace is not a Git repository; only the listed files were copied.')
for kind in ('files','inputs'):
    for path in args.get(kind) or []:
        found=walk(inside(path))
        if found is None: problems.append({'kind':'declared-missing','path':path,'detail':'This '+('deliverable' if kind=='files' else 'input')+' does not exist in the workspace.'}); continue
        for rel in found: selected.setdefault(rel,'delivered' if kind=='files' else 'input')
if len(selected)>MAX_FILES: fail('More than %d files would be copied; list the deliverable files instead.'%MAX_FILES)
base=os.path.realpath(tempfile.mkdtemp(prefix='ytimesy-deliverable-'))
os.chmod(base,0o755)
copy=os.path.join(base,'work'); home=os.path.join(base,'home'); temporary=os.path.join(base,'tmp')
for directory in (copy,home,temporary): os.makedirs(directory)
total=0
for rel in sorted(selected):
    source=os.path.join(root,rel); target=os.path.join(copy,rel)
    os.makedirs(os.path.dirname(target),exist_ok=True)
    if os.path.islink(source): os.symlink(os.readlink(source),target); continue
    total+=os.path.getsize(source)
    if total>MAX_BYTES: shutil.rmtree(base,ignore_errors=True); fail('The delivered files exceed 1 GiB.')
    shutil.copy2(source,target)
CODE=('.py','.pyw','.js','.mjs','.cjs','.ts','.sh','.bash','.rb','.go','.rs','.c','.h','.cc','.cpp','.java','.pl','.php','.r','.jl','.lua')
DEPENDENCY=re.compile(r'(requirements.*\.txt|pyproject\.toml|setup\.(py|cfg)|environment\.yml|Pipfile(\.lock)?|package(-lock)?\.json|Cargo\.(toml|lock)|go\.(mod|sum)|Gemfile(\.lock)?)$')
named_data={inside(item) for item in args.get('namedData') or []}
data_files=[rel for rel,kind in selected.items() if kind=='delivered' and listed_only and not rel.lower().endswith(CODE) and not DEPENDENCY.match(os.path.basename(rel)) and rel not in named_data and rel not in command and os.path.basename(rel) not in command and not os.path.islink(os.path.join(copy,rel))][:200]
# Reads show as a changed access time; where the mount does not record one,
# a delivered file naming the data file counts as reading it.
probe=os.path.join(base,'atime-probe')
with open(probe,'w') as handle: handle.write('x')
os.utime(probe,(0,os.stat(probe).st_mtime))
with open(probe) as handle: handle.read()
atime_works=os.stat(probe).st_atime>0
os.remove(probe)
for rel in data_files:
    try: os.utime(os.path.join(copy,rel),(0,os.stat(os.path.join(copy,rel)).st_mtime))
    except OSError: pass
omitted=[]
for directory,subdirectories,names in os.walk(root):
    subdirectories[:]=[name for name in subdirectories if name not in CACHE]
    for name in names:
        rel=os.path.relpath(os.path.join(directory,name),root)
        if rel not in selected and not name.endswith('.pyc'): omitted.append(rel)
    if len(omitted)>200: break
ambient=[name for name in ('PYTHONPATH','PYTHONHOME','VIRTUAL_ENV','CONDA_PREFIX','NODE_PATH','NODE_OPTIONS','LD_LIBRARY_PATH','LD_PRELOAD','CLASSPATH','GOPATH','GEM_PATH','PERL5LIB') if os.environ.get(name)]
for name in args.get('keepEnv') or []: ambient=[item for item in ambient if item!=name]
path=[]
for entry in os.environ.get('PATH','/usr/local/bin:/usr/bin:/bin').split(':'):
    real=os.path.realpath(entry) if entry else entry
    if real==root or real.startswith(root+os.sep): path.append(os.path.join(copy,os.path.relpath(real,root)))
    else: path.append(entry)
environment={'PATH':':'.join(path),'HOME':home,'TMPDIR':temporary,'LANG':os.environ.get('LANG','C.UTF-8'),'TERM':'dumb','NO_COLOR':'1'}
for name in args.get('keepEnv') or []:
    if name in os.environ: environment[name]=os.environ[name]
ran_as='uid %d'%os.geteuid(); demote=None
if args.get('unprivileged'):
    if os.geteuid()!=0: ran_as+=' (already unprivileged)'
    else:
        import pwd
        try: account=pwd.getpwnam('nobody')
        except KeyError: account=None
        if account is None: warnings.append('No unprivileged account named nobody exists; ran as root.')
        else:
            for directory,subdirectories,names in os.walk(base):
                for name in [directory]+[os.path.join(directory,item) for item in names]:
                    try: os.lchown(name,account.pw_uid,account.pw_gid)
                    except OSError: pass
            environment.update({'USER':'nobody','LOGNAME':'nobody'})
            ran_as='nobody (uid %d)'%account.pw_uid
            def demote():
                os.setgroups([]); os.setgid(account.pw_gid); os.setuid(account.pw_uid)
escaped='|'.join(re.escape(alias) for alias in aliases)
run_command=re.sub('(?:'+escaped+r')(?=/|[\s\'";:|&<>()]|$)',lambda match: copy,command)
started=time.monotonic(); timed_out=False
process=subprocess.Popen(['bash','-c',run_command],cwd=copy,env=environment,stdout=subprocess.PIPE,stderr=subprocess.PIPE,start_new_session=True,preexec_fn=demote)
try: stdout,stderr=process.communicate(timeout=limit)
except subprocess.TimeoutExpired:
    timed_out=True
    try: os.killpg(process.pid,signal.SIGKILL)
    except ProcessLookupError: pass
    stdout,stderr=process.communicate()
elapsed=round(time.monotonic()-started,2)
def accessed(rel):
    if not atime_works: return True
    try: return os.stat(os.path.join(copy,rel)).st_atime>0
    except OSError: return True
read_at_run={rel for rel in data_files if accessed(rel)}
stdout=stdout.decode('utf-8','replace'); stderr=stderr.decode('utf-8','replace')
output=stdout+'\n'+stderr
def original(path):
    path=path.strip().strip('\'"')
    if path.startswith(copy+'/'): return os.path.relpath(path,copy)
    for alias in aliases:
        if path.startswith(alias+'/'): return os.path.relpath(path,alias)
    if not os.path.isabs(path): return os.path.normpath(path)
    return None
seen=set()
for pattern in (r"No such file or directory:? '([^'\n]+)'",r"ENOENT[^'\n]*'([^'\n]+)'",r"Cannot find module '([^'\n]+)'",r"(?:^|\s)([^\s:'\"]+): No such file or directory",r"FileNotFoundError: (?:\[Errno 2\] )?[^'\n]*'([^'\n]+)'",r"can't open file '([^'\n]+)'"):
    for match in re.finditer(pattern,output,re.M):
        rel=original(match.group(1))
        if rel is None or rel in seen or rel.startswith('..'): continue
        seen.add(rel)
        if os.path.lexists(os.path.join(root,rel)) and not os.path.lexists(os.path.join(copy,rel)):
            problems.append({'kind':'missing-file','path':rel,'detail':'The run needed this file. It exists in the workspace but is not tracked or declared, so a third party would not receive it.'})
        elif not os.path.lexists(os.path.join(copy,rel)):
            problems.append({'kind':'missing-file','path':rel,'detail':'The run needed this file and it is not delivered.'})
for match in re.finditer(r"No module named '([\w.]+)'",output):
    module=match.group(1).split('.')[0]
    if module in seen: continue
    seen.add(module)
    local=any(os.path.exists(os.path.join(root,candidate)) for candidate in (module+'.py',module))
    problems.append({'kind':'missing-module','path':module,'detail':'A local module that is not delivered.' if local else 'Not importable in a clean environment; declare and install it, or avoid it. It may only be present in the workspace virtualenv, user site-packages or PYTHONPATH.'})
for line in output.splitlines():
    if 'Permission denied' in line or 'Operation not permitted' in line:
        problems.append({'kind':'permission','path':None,'detail':line.strip()[:300]}); break
for line in output.splitlines():
    if re.search(r'command not found|: not found$',line):
        problems.append({'kind':'missing-command','path':None,'detail':line.strip()[:300]}); break
pattern=re.compile('(?:'+escaped+r')/([\w./-]+)')
for rel,kind in list(selected.items())[:2000]:
    if kind!='delivered': continue
    try:
        if os.path.getsize(os.path.join(copy,rel))>2_000_000: continue
        text=open(os.path.join(copy,rel),errors='strict').read()
    except (OSError,UnicodeDecodeError): continue
    for match in pattern.finditer(text):
        target=os.path.normpath(match.group(1)).rstrip('/')
        if target in seen or any(item==target or item.startswith(target+'/') for item in selected): continue
        seen.add(target)
        if os.path.lexists(os.path.join(root,target)):
            problems.append({'kind':'absolute-reference','path':target,'detail':rel+' reads '+os.path.join(root,target)+' by absolute path, which is neither delivered nor listed as an input. The clean run still saw the workspace copy; a third party will not have it.'})
readers={}
for rel,kind in selected.items():
    if kind!='delivered' or rel in data_files or not data_files: continue
    try:
        if os.path.getsize(os.path.join(copy,rel))>2_000_000: continue
        text=open(os.path.join(copy,rel),errors='strict').read()
    except (OSError,UnicodeDecodeError): continue
    for data in data_files:
        if os.path.basename(data) in text: readers.setdefault(data,rel)
for data,reader in readers.items():
    if data not in read_at_run: continue
    problems.append({'kind':'undeclared-by-task','path':data,'detail':reader+' reads '+data+' at run time, and the clean run had it only because you listed it in files. A grader receives only the files the task says are delivered: if the task does not name '+data+', it will be missing there. Build it into a file the task names, or generate it at run time, then check again without it. If the task itself names '+data+' as a deliverable, pass it in namedData.'})
python_files=[rel for rel,kind in selected.items() if kind=='delivered' and rel.endswith('.py')][:200]
if python_files:
    imported=set(); local=set()
    for rel in selected:
        if rel.endswith('.py'): local.add(os.path.splitext(os.path.basename(rel))[0])
        for part in os.path.dirname(rel).split(os.sep):
            if part: local.add(part)
    for rel in python_files:
        try: tree=ast.parse(open(os.path.join(copy,rel),'rb').read())
        except (SyntaxError,ValueError) as error:
            problems.append({'kind':'syntax','path':rel,'detail':str(error)[:300]}); continue
        for node in ast.walk(tree):
            if isinstance(node,ast.Import): imported.update(alias.name.split('.')[0] for alias in node.names)
            elif isinstance(node,ast.ImportFrom) and not node.level and node.module: imported.add(node.module.split('.')[0])
    standard=set(getattr(sys,'stdlib_module_names',()))|set(sys.builtin_module_names)|{'__future__'}
    third=sorted(name for name in imported if name not in standard and name not in local)
    if third:
        probe=subprocess.run(['python3','-c','import importlib.util,sys; print(" ".join(m for m in sys.argv[1:] if importlib.util.find_spec(m) is None))',*third],cwd=copy,env=environment,capture_output=True,preexec_fn=demote,timeout=60)
        for module in probe.stdout.decode().split():
            if module not in seen: problems.append({'kind':'missing-module','path':module,'detail':'Imported by a delivered file but not importable by python3 in a clean environment.'})
        declared=''.join(open(os.path.join(copy,rel),errors='replace').read().lower() for rel in selected if os.path.basename(rel) in ('requirements.txt','pyproject.toml','setup.py','setup.cfg','environment.yml','Pipfile') or re.match(r'requirements.*\.txt$',os.path.basename(rel))).replace('_','-')
        try:
            from importlib.metadata import packages_distributions
            distributions=packages_distributions()
        except Exception: distributions={}
        if declared:
            for module in third:
                names={module.lower()}|{name.lower() for name in distributions.get(module,[])}
                if not any(re.search(r'(?<![\w.-])'+re.escape(name.replace('_','-'))+r'(?![\w])',declared) for name in names):
                    warnings.append('A delivered file imports '+module+', but no delivered dependency file names it.')
        else: warnings.append('Delivered files import third-party modules ('+', '.join(third)+') and no dependency file (requirements.txt, pyproject.toml) is delivered.')
if ambient: warnings.append('Cleared from the run environment: '+', '.join(ambient)+'. Pass keepEnv only if the user or grader sets them too.')
if run_command!=command: warnings.append('Workspace paths in the command were pointed at the clean copy.')
if not args.get('keep'): shutil.rmtree(base,ignore_errors=True)
exit_ok=process.returncode==0 and not timed_out
report={'ok':exit_ok and not problems,'exitCode':process.returncode,'timedOut':timed_out,'seconds':elapsed,'limitSeconds':limit,'ranAs':ran_as,'copiedFiles':len(selected),'problems':problems[:12],'warnings':warnings[:8],'notDelivered':{'count':len(omitted),'sample':omitted[:15]},'stdoutTail':stdout[-2500:],'stderrTail':stderr[-2500:]}
if args.get('keep'): report['copy']=copy
print(json.dumps(report))`;

export const deliverableCheckInput = z.object({
	command: z.string().min(1).max(8000),
	files: z.array(z.string().min(1).max(1000)).max(200).default([]),
	tracked: z.boolean().default(true),
	inputs: z.array(z.string().min(1).max(1000)).max(200).default([]),
	/** Entries of `files` the task itself names that the deliverable also reads at run time. */
	namedData: z.array(z.string().min(1).max(1000)).max(200).default([]),
	unprivileged: z.boolean().default(false),
	timeoutSeconds: z.number().int().min(1).max(540).default(120),
	keepEnv: z
		.array(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/))
		.max(32)
		.default([]),
});

/** The shell command that runs the check from the workspace directory. */
export function deliverableCheckCommand(
	input: z.input<typeof deliverableCheckInput> & { cwd?: string },
) {
	const parsed = { ...deliverableCheckInput.parse(input), cwd: input.cwd };
	return `python3 -c ${posixShellQuoted(DELIVERABLE_CHECK_SOURCE)} ${Buffer.from(JSON.stringify(parsed)).toString("base64")}`;
}

/** check_deliverable reuses execute_command, so stopping, timeouts and output paging behave the same. */
export function deliverableCheckTools(
	executeCommand: NonNullable<ToolSet[string]["execute"]> | undefined,
): ToolSet {
	if (!executeCommand) return {};
	return {
		check_deliverable: tool({
			description:
				"Run your deliverable the way a third party would: copy only the delivered files (Git-tracked files plus `files`, plus any `inputs` the user or grader supplies) into a fresh temporary directory, clear the environment (no workspace virtualenv, PYTHONPATH or untracked data), optionally run as an unprivileged user, and run `command` there within timeoutSeconds. Workspace paths in the command point at the copy. Reports missing files and modules, permission failures and the exit status. When the task names its output files, list exactly those in `files` and set tracked:false: a grader receives only what the task names, so do not add data files, models or helpers the deliverable reads unless the task names them too (it reports a delivered file that reads an unnamed one at run time; pass a data file the task does name in `namedData`).",
			inputSchema: deliverableCheckInput,
			execute: (input, options) =>
				executeCommand(
					{
						command: deliverableCheckCommand(input),
						maxSeconds: Math.min(600, (input.timeoutSeconds ?? 120) + 60),
						yieldSeconds: 30,
					},
					options,
				),
		}),
	};
}
