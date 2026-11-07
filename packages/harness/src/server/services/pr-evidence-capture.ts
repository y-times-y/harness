import { posixShellQuoted as quote } from "../../domain/posix-command";
import { EVIDENCE_LIMITS } from "../../domain/pr-evidence";
import {
	guestCapabilityDirectory,
	guestCapabilityPackages,
} from "./guest-node-capability";

/**
 * The capture engine that runs in the workspace VM: a Python orchestrator
 * (checkout identity, app start, bounds, hashes, manifest) and a Playwright
 * program (pages, flow, screenshots, recording). The harness writes a fresh
 * copy next to each capture, so a verified capture never runs a script the
 * model could have edited; `ytimesy-evidence` runs the installed copy for the
 * builder's preview.
 */

const VIEWPORT = { width: 1280, height: 800 };
const VIDEO_SIZE = { width: 1024, height: 640 };

/** Playwright, its pinned ffmpeg and (without a system Chrome) its headless shell, shared with browser_inspect. */
export const EVIDENCE_CAPABILITY_DIRECTORY =
	guestCapabilityDirectory("browser");

export const EVIDENCE_CAPTURE_MJS = `
import { createRequire } from 'node:module';
import { mkdirSync, renameSync, rmSync } from 'node:fs';
import { join } from 'node:path';
const require = createRequire(process.argv[2] + '/package.json');
const { chromium } = require('playwright-core');
const input = JSON.parse(process.argv[3]);
const started = Date.now();
const browser = await chromium.launch({ headless: true, executablePath: input.executablePath || undefined, args: ['--no-sandbox', '--disable-dev-shm-usage', '--disable-gpu'] });
const result = { pages: [], flow: [], video: null, browser: 'Chrome ' + browser.version() + ' headless, Playwright ' + input.playwright, viewport: input.viewport.width + 'x' + input.viewport.height };
const videoDir = join(input.outDir, 'video-tmp');
mkdirSync(videoDir, { recursive: true });
const context = await browser.newContext({ viewport: input.viewport, ignoreHTTPSErrors: true, recordVideo: { dir: videoDir, size: input.videoSize } });
const page = await context.newPage();
page.setDefaultTimeout(input.stepTimeoutMs);
page.setDefaultNavigationTimeout(30000);
let shots = 0;
const slug = text => (text.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 24) || 'home');
const shoot = async label => {
  if (shots >= input.maxScreenshots) return null;
  shots += 1;
  const name = String(shots).padStart(2, '0') + '-' + slug(label) + '.png';
  await page.screenshot({ path: join(input.outDir, name) });
  return name;
};
const message = error => String((error && error.message) || error).split('\\n')[0].slice(0, 400);
const late = () => Date.now() - started > input.videoSeconds * 1000;
const absolute = url => new URL(url, input.base).href;
const describe = step => {
  switch (step.action) {
    case 'goto': return 'goto ' + step.url;
    case 'click': return 'click ' + step.selector;
    case 'fill': return 'fill ' + step.selector;
    case 'press': return 'press ' + step.key + (step.selector ? ' in ' + step.selector : '');
    case 'wait': return 'wait ' + step.ms + ' ms';
    case 'waitFor': return 'wait for ' + step.selector;
    case 'screenshot': return 'screenshot' + (step.name ? ' ' + step.name : '');
    default: return String(step.action);
  }
};
const settle = async () => {
  await page.waitForLoadState('networkidle', { timeout: 5000 }).catch(() => {});
  await page.waitForTimeout(400);
};
for (const url of input.urls) {
  const entry = { url, status: null, title: '', screenshot: null, error: '' };
  if (late()) { entry.error = 'skipped: capture time limit reached'; result.pages.push(entry); continue; }
  try {
    const response = await page.goto(url, { waitUntil: 'load' });
    entry.status = response ? response.status() : null;
    await settle();
    entry.title = (await page.title()).slice(0, 300);
    const path = new URL(url).pathname;
    entry.screenshot = await shoot(path === '/' ? 'home' : path);
  } catch (error) {
    entry.error = message(error);
  }
  result.pages.push(entry);
}
let failed = false;
for (const [index, step] of input.flow.entries()) {
  const entry = { step: describe(step), ok: false, error: '', screenshot: null };
  if (failed) { entry.error = 'skipped after a failed step'; result.flow.push(entry); continue; }
  if (late()) { entry.error = 'skipped: recording time limit reached'; result.flow.push(entry); continue; }
  try {
    if (step.action === 'goto') { await page.goto(absolute(step.url), { waitUntil: 'load' }); await settle(); }
    else if (step.action === 'click') { await page.click(step.selector); await settle(); }
    else if (step.action === 'fill') await page.fill(step.selector, step.text);
    else if (step.action === 'press') { if (step.selector) await page.press(step.selector, step.key); else await page.keyboard.press(step.key); await settle(); }
    else if (step.action === 'wait') await page.waitForTimeout(step.ms);
    else if (step.action === 'waitFor') await page.waitForSelector(step.selector, { state: 'visible' });
    else if (step.action === 'screenshot') entry.screenshot = await shoot(step.name || 'step-' + (index + 1));
    else throw new Error('unknown step');
    entry.ok = true;
  } catch (error) {
    entry.error = message(error);
    failed = true;
    entry.screenshot = await shoot('failed-step-' + (index + 1)).catch(() => null);
  }
  result.flow.push(entry);
}
const video = page.video();
const seconds = (Date.now() - started) / 1000;
await context.close();
await browser.close();
if (video) {
  renameSync(await video.path(), join(input.outDir, 'recording.webm'));
  result.video = { file: 'recording.webm', seconds };
}
rmSync(videoDir, { recursive: true, force: true });
console.log(JSON.stringify(result));
`;

const LIMITS_JSON = JSON.stringify({
	...EVIDENCE_LIMITS,
	viewport: VIEWPORT,
	videoSize: VIDEO_SIZE,
	playwright: guestCapabilityPackages.browser[0],
});

/**
 * argv: request.json, output directory, verify|preview, repository directory,
 * revision (verify only), capability directory. Exit 0 only when captured.
 */
export const EVIDENCE_CAPTURE_PY = `import hashlib, json, os, re, shutil, signal, subprocess, sys, tempfile, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone
LIMITS = json.loads(${JSON.stringify(LIMITS_JSON)})
request_path, out, mode, repo, revision, capability = sys.argv[1:7]
here = os.path.dirname(os.path.abspath(__file__))
os.makedirs(out, exist_ok=True)
def now():
    return datetime.now(timezone.utc).isoformat(timespec='seconds').replace('+00:00', 'Z')
ANSI = re.compile(r'\\x1b\\[[0-9;?]*[ -/]*[@-~]|\\x1b\\][^\\x07]*\\x07')
request = json.load(open(request_path, encoding='utf-8'))
kind = 'cli' if request.get('mode') == 'cli' else 'web'
manifest = {'version': 1, 'mode': mode, 'kind': kind, 'status': 'captured', 'reason': '', 'sha': '', 'clean': False,
            'startCommand': '', 'startSource': 'cli' if kind == 'cli' else ('auto' if request.get('mode') == 'auto' else 'plan'),
            'urls': [], 'pages': [], 'flow': [], 'video': None, 'cli': None, 'files': [], 'dropped': [],
            'browser': '', 'viewport': '', 'linked': [], 'startedAt': now(), 'appReadyAt': '', 'finishedAt': ''}
app = None
checkout = repo
worktree = None
log_path = os.path.join(out, 'app.log')
child_env = {**os.environ, 'BROWSER': 'none', 'NO_COLOR': '1', 'FORCE_COLOR': '0'}
def stop_app():
    if app is None or app.poll() is not None: return
    for sig, wait in ((signal.SIGTERM, 5), (signal.SIGKILL, 5)):
        try: os.killpg(app.pid, sig)
        except ProcessLookupError: return
        try:
            app.wait(wait); return
        except subprocess.TimeoutExpired: pass
def remove_worktree():
    if worktree:
        subprocess.run(['git', '-C', repo, 'worktree', 'remove', '--force', worktree], capture_output=True)
        subprocess.run(['git', '-C', repo, 'worktree', 'prune'], capture_output=True)
def finish(status=None, reason=''):
    stop_app()
    remove_worktree()
    if status:
        manifest['status'] = status
        manifest['reason'] = reason[:600]
    manifest['finishedAt'] = now()
    files, pngs = [], 0
    for name in sorted(os.listdir(out)):
        path = os.path.join(out, name)
        if not os.path.isfile(path) or not re.fullmatch(r'[a-z0-9][a-z0-9-]{0,40}\\.(png|webm|txt)', name): continue
        size = os.path.getsize(path)
        limit = LIMITS['videoBytes'] if name.endswith('.webm') else LIMITS['screenshotBytes'] if name.endswith('.png') else 262144
        if manifest['status'] != 'captured' or size > limit or (name.endswith('.png') and pngs >= LIMITS['screenshots']):
            os.remove(path)
            if manifest['status'] == 'captured': manifest['dropped'].append('%s (%d bytes)' % (name, size))
            continue
        pngs += name.endswith('.png')
        with open(path, 'rb') as handle: digest = hashlib.sha256(handle.read()).hexdigest()
        files.append({'name': name, 'bytes': size, 'sha256': digest})
    manifest['files'] = files
    kept = {item['name'] for item in files}
    for page in manifest['pages']:
        if page.get('screenshot') not in kept: page['screenshot'] = None
    for step in manifest['flow']:
        if step.get('screenshot') not in kept: step['screenshot'] = None
    if manifest['video'] and manifest['video']['file'] not in kept: manifest['video'] = None
    with open(os.path.join(out, 'manifest.json'), 'w', encoding='utf-8') as handle: json.dump(manifest, handle, indent=2)
    print(json.dumps(manifest))
    sys.exit(0 if manifest['status'] == 'captured' else 1)
def git(*args, env=None):
    return subprocess.run(['git', '-C', repo, *args], capture_output=True, text=True, env=env)
found = git('rev-parse', '--verify', (revision or 'HEAD') + '^{commit}')
if found.returncode: finish('dirty', 'The commit to capture is not in the workspace checkout.')
manifest['sha'] = found.stdout.strip()
def link_workspace_files(source, target):
    # Untracked inputs the app needs that are not in the commit: installed
    # dependencies (linked) and local env files (copied). Recorded in the manifest.
    for root, directories, names in os.walk(source):
        relative = os.path.relpath(root, source)
        depth = 0 if relative == '.' else relative.count(os.sep) + 1
        for name in list(directories):
            if name in ('node_modules', '.venv', 'venv') and len(manifest['linked']) < 40:
                destination = os.path.join(target, relative, name)
                if os.path.isdir(os.path.dirname(destination)) and not os.path.lexists(destination):
                    os.symlink(os.path.join(root, name), destination)
                    manifest['linked'].append(os.path.normpath(os.path.join(relative, name)))
        directories[:] = [name for name in directories if depth < 4 and name not in ('.git', 'node_modules', '.venv', 'venv') and not name.startswith('.')]
        for name in names:
            if re.fullmatch(r'.env(..+)?', name) and len(manifest['linked']) < 40:
                destination = os.path.join(target, relative, name)
                if os.path.isdir(os.path.dirname(destination)) and not os.path.lexists(destination) and os.path.getsize(os.path.join(root, name)) <= 65536:
                    shutil.copyfile(os.path.join(root, name), destination)
                    manifest['linked'].append(os.path.normpath(os.path.join(relative, name)))
if mode == 'verify':
    # A separate worktree of exactly the pushed commit, so later edits in the
    # chat's checkout (or a running next turn) cannot leak into the capture.
    worktree = os.path.join(os.path.dirname(os.path.abspath(out)), 'src')
    added = git('worktree', 'add', '--detach', '--force', worktree, manifest['sha'])
    if added.returncode:
        worktree = None
        finish('dirty', 'The pushed commit could not be checked out for capture.')
    checkout = worktree
    manifest['clean'] = True
    link_workspace_files(repo, checkout)
else:
    tree = git('rev-parse', manifest['sha'] + '^{tree}').stdout.strip()
    with tempfile.TemporaryDirectory(prefix='ytimesy-evidence-tree-') as temporary:
        env = {**os.environ, 'GIT_INDEX_FILE': temporary + '/index'}
        git('read-tree', manifest['sha'], env=env)
        git('-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null', 'add', '-A', '--', '.', env=env)
        working = git('write-tree', env=env).stdout.strip()
    manifest['clean'] = bool(tree) and working == tree
def run_group(argv, seconds, **options):
    process = subprocess.Popen(argv, cwd=checkout, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, start_new_session=True, env=child_env, **options)
    try:
        output, _ = process.communicate(timeout=seconds)
        return process.returncode, output
    except subprocess.TimeoutExpired:
        try: os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError: pass
        output, _ = process.communicate()
        return None, output
if kind == 'cli':
    command = request['command']
    manifest['startCommand'] = command
    code, output = run_group(['bash', '-lc', command], LIMITS['cliSeconds'])
    text = ANSI.sub('', output.decode('utf-8', 'replace')).replace('\\r\\n', '\\n')
    if len(text) > LIMITS['cliOutputChars']:
        text = text[:LIMITS['cliOutputChars']] + '\\n[output truncated]'
    with open(os.path.join(out, 'output.txt'), 'w', encoding='utf-8') as handle: handle.write(text)
    manifest['cli'] = {'command': command, 'exitCode': code, 'file': 'output.txt'}
    finish()
start, urls, flow, start_seconds = None, [], [], LIMITS['startSeconds']['default']
if request.get('mode') == 'auto':
    try:
        scripts = json.load(open(os.path.join(checkout, 'package.json'), encoding='utf-8')).get('scripts') or {}
    except (OSError, ValueError):
        scripts = {}
    if not isinstance(scripts.get('dev'), str):
        finish('app-failed', 'No capture plan was recorded and package.json has no dev script, so the harness could not tell how to start the app.')
    manager = 'pnpm' if os.path.exists(os.path.join(checkout, 'pnpm-lock.yaml')) else 'yarn' if os.path.exists(os.path.join(checkout, 'yarn.lock')) else 'bun' if any(os.path.exists(os.path.join(checkout, name)) for name in ('bun.lockb', 'bun.lock')) else 'npm'
    start = manager + ' run dev'
else:
    start, urls, flow = request['start'], list(request['urls']), list(request.get('flow') or [])
    start_seconds = int(request.get('startSeconds') or start_seconds)
manifest['startCommand'] = start
def chrome():
    for name in ('google-chrome-stable', 'google-chrome', 'chromium', 'chromium-browser'):
        path = shutil.which(name)
        if path: return path
    return None
def tooling():
    package = LIMITS['playwright']
    script = '(flock -w 150 9; if ! test -f ready; then timeout --kill-after=5s 120s npm install --prefix . --ignore-scripts --no-audit --no-fund --package-lock=false %s >&2 && touch ready; fi) 9>install.lock' % package
    os.makedirs(capability, exist_ok=True)
    installed = subprocess.run(['bash', '-c', script], cwd=capability, capture_output=True, text=True, timeout=200)
    if installed.returncode or not os.path.exists(os.path.join(capability, 'ready')):
        return 'Playwright could not be installed in the workspace: ' + (installed.stderr.strip().splitlines() or ['no output'])[-1][:200]
    targets = ['ffmpeg'] + ([] if chrome() else ['chromium-headless-shell'])
    cli = os.path.join(capability, 'node_modules', 'playwright-core', 'cli.js')
    script = '(flock -w 200 9; timeout --kill-after=5s 180s node %s install --no-remove %s >&2) 9>browsers.lock' % (cli, ' '.join(targets))
    browsers = subprocess.run(['bash', '-c', script], cwd=capability, capture_output=True, text=True, timeout=240)
    if browsers.returncode:
        return 'The recording tools could not be installed: ' + (browsers.stderr.strip().splitlines() or ['no output'])[-1][:200]
    return None
problem = tooling()
if problem: finish('tooling-failed', problem)
LOCAL = re.compile(r'https?://(?:localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\]):\\d+[^\\s"\\'<>]*')
def answers(url):
    try:
        urllib.request.urlopen(urllib.request.Request(url, method='GET'), timeout=3).close()
        return True
    except urllib.error.HTTPError:
        return True
    except Exception:
        return False
base = next((url for url in urls if not url.startswith('/')), None)
if base and answers(base):
    finish('app-failed', 'Something was already answering at %s before the app started (another dev server in the workspace?), so screenshots could show other code. Stop it or use a free port in the plan.' % base)
log = open(log_path, 'wb')
app = subprocess.Popen(['bash', '-lc', start], cwd=checkout, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT, start_new_session=True, env=child_env)
deadline = time.time() + start_seconds
while True:
    if app.poll() is not None:
        finish('app-failed', 'The start command exited with status %d before the app answered.' % app.returncode)
    if base is None:
        with open(log_path, 'rb') as handle: text = ANSI.sub('', handle.read()[-200000:].decode('utf-8', 'replace'))
        match = LOCAL.search(text)
        if match: base = match.group(0).replace('0.0.0.0', 'localhost').rstrip('.,;)')
    if base and answers(base): break
    if time.time() > deadline:
        finish('app-failed', 'Nothing answered at %s within %d s of starting it.' % (base or 'a localhost URL in its output', start_seconds))
    time.sleep(1)
manifest['appReadyAt'] = now()
resolved = [urllib.parse.urljoin(base, url) for url in urls] or [base]
manifest['urls'] = resolved
arguments = {'outDir': out, 'base': base, 'urls': resolved, 'flow': flow, 'viewport': LIMITS['viewport'], 'videoSize': LIMITS['videoSize'],
             'videoSeconds': LIMITS['videoSeconds'], 'stepTimeoutMs': LIMITS['stepTimeoutMs'], 'maxScreenshots': LIMITS['screenshots'],
             'executablePath': chrome(), 'playwright': LIMITS['playwright'].split('@')[-1]}
seconds = LIMITS['videoSeconds'] + 30 * len(resolved) + 30
captured = subprocess.run(['timeout', '--kill-after=5s', '%ds' % seconds, 'node', os.path.join(here, 'evidence-capture.mjs'), capability, json.dumps(arguments)],
                          capture_output=True, text=True, timeout=seconds + 15, env=child_env)
lines = captured.stdout.strip().splitlines()
try:
    result = json.loads(lines[-1]) if lines else None
except ValueError:
    result = None
if captured.returncode or not isinstance(result, dict):
    finish('tooling-failed', 'The browser capture failed: ' + ((captured.stderr.strip().splitlines() or ['timed out' if captured.returncode == 124 else 'no output'])[-1])[:200])
for key in ('pages', 'flow', 'video', 'browser', 'viewport'):
    manifest[key] = result.get(key, manifest[key])
finish()
`;

/** The files a capture runs from, by name in its directory. */
export function evidenceCaptureFiles() {
	return {
		"evidence-capture.py": EVIDENCE_CAPTURE_PY,
		"evidence-capture.mjs": EVIDENCE_CAPTURE_MJS,
	};
}

/** Runs the capture in `directory` (which holds the files above and request.json), bounded in time. */
export function evidenceCaptureCommand(input: {
	directory: string;
	repository: string;
	revision: string;
}) {
	return `timeout --kill-after=10s ${EVIDENCE_LIMITS.captureSeconds}s python3 ${quote(`${input.directory}/evidence-capture.py`)} ${quote(`${input.directory}/request.json`)} ${quote(`${input.directory}/out`)} verify ${quote(input.repository)} ${quote(input.revision)} ${quote(EVIDENCE_CAPABILITY_DIRECTORY)}`;
}

const HELPER_USAGE = `usage: ytimesy-evidence capture --start '<command that serves the app>' --url <localhost URL or /path> [--url ...] [--flow <steps.json>] [--start-timeout <seconds>]
       ytimesy-evidence capture --cli '<command whose output shows the change>'
       ytimesy-evidence show | clear
Flow steps (JSON list, at most ${EVIDENCE_LIMITS.flowSteps}): {"action":"goto","url":"/x"} {"action":"click","selector":"text=Save"}
  {"action":"fill","selector":"#name","text":"Ada"} {"action":"press","key":"Enter"} {"action":"wait","ms":500}
  {"action":"waitFor","selector":".toast"} {"action":"screenshot","name":"saved"}`;

/**
 * \`ytimesy-evidence\`: saves the capture plan the harness uses when this
 * chat's changes are handed off as a pull request, and previews it now.
 */
export const EVIDENCE_HELPER_SCRIPT = `#!/usr/bin/env python3
# ytimesy-evidence: plan the screenshots, recording or CLI output shown in the pull request.
import json, os, re, subprocess, sys, time
USAGE = ${JSON.stringify(HELPER_USAGE)}
LIB = os.path.join(os.path.dirname(os.path.dirname(os.path.realpath(__file__))), 'lib')
PLAN = os.path.expanduser('~/.ytimesy/evidence/request.json')
CAPABILITY = ${JSON.stringify(EVIDENCE_CAPABILITY_DIRECTORY)}
ACTIONS = {'goto', 'click', 'fill', 'press', 'wait', 'waitFor', 'screenshot'}
LOCAL = re.compile(r'^(/(?!/)|https?://(localhost|127\\.0\\.0\\.1|0\\.0\\.0\\.0|\\[::1\\])(:\\d+)?(/|$))')
def fail(message):
    print(message + '\\n' + USAGE, file=sys.stderr); sys.exit(2)
argv = sys.argv[1:]
if not argv or argv[0] in ('-h', '--help'):
    print(USAGE); sys.exit(0)
if argv[0] == 'show':
    print(open(PLAN).read() if os.path.exists(PLAN) else 'No capture plan saved.'); sys.exit(0)
if argv[0] == 'clear':
    if os.path.exists(PLAN): os.remove(PLAN)
    print('Capture plan removed; the pull request gets evidence only if its diff changes visible files and package.json has a dev script.'); sys.exit(0)
if argv[0] != 'capture': fail('unknown command ' + argv[0])
options, index = {'url': []}, 1
while index < len(argv):
    key = argv[index]
    if key not in ('--start', '--url', '--flow', '--cli', '--start-timeout') or index + 1 >= len(argv): fail('unknown or incomplete option ' + key)
    value = argv[index + 1]
    if key == '--url': options['url'].append(value)
    else: options[key[2:]] = value
    index += 2
if 'cli' in options:
    if 'start' in options or options['url']: fail('--cli captures command output; leave out --start and --url')
    request = {'version': 1, 'mode': 'cli', 'command': options['cli'].strip()}
    if not request['command'] or len(request['command']) > ${EVIDENCE_LIMITS.startCommandChars} or '\\n' in request['command']: fail('--cli takes one command line')
else:
    if not options.get('start') or not options['url']: fail('capture needs --start and at least one --url (or --cli)')
    if len(options['start']) > ${EVIDENCE_LIMITS.startCommandChars} or '\\n' in options['start']: fail('--start takes one command line')
    if len(options['url']) > ${EVIDENCE_LIMITS.urls}: fail('at most ${EVIDENCE_LIMITS.urls} --url')
    for url in options['url']:
        if not LOCAL.match(url): fail('--url must be the app in this workspace (http://localhost:PORT/... or /path): ' + url)
    flow = []
    if 'flow' in options:
        try: flow = json.load(open(options['flow'], encoding='utf-8'))
        except (OSError, ValueError) as error: fail('--flow must name a JSON file: ' + str(error))
        if not isinstance(flow, list) or len(flow) > ${EVIDENCE_LIMITS.flowSteps} or any(not isinstance(step, dict) or step.get('action') not in ACTIONS for step in flow):
            fail('--flow must be a JSON list of at most ${EVIDENCE_LIMITS.flowSteps} steps with known actions')
    seconds = options.get('start-timeout', '${EVIDENCE_LIMITS.startSeconds.default}')
    if not seconds.isdigit() or not 5 <= int(seconds) <= ${EVIDENCE_LIMITS.startSeconds.max}: fail('--start-timeout takes 5 to ${EVIDENCE_LIMITS.startSeconds.max} seconds')
    request = {'version': 1, 'mode': 'web', 'start': options['start'].strip(), 'urls': options['url'], 'flow': flow, 'startSeconds': int(seconds)}
os.makedirs(os.path.dirname(PLAN), exist_ok=True)
with open(PLAN, 'w', encoding='utf-8') as handle: json.dump(request, handle, indent=2)
top = subprocess.run(['git', 'rev-parse', '--show-toplevel'], capture_output=True, text=True)
repo = top.stdout.strip() if top.returncode == 0 else os.getcwd()
out = '/tmp/ytimesy-evidence-preview-' + time.strftime('%Y%m%d-%H%M%S')
result = subprocess.run(['python3', os.path.join(LIB, 'evidence-capture.py'), PLAN, out, 'preview', repo, '', CAPABILITY], capture_output=True, text=True)
try:
    manifest = json.loads(result.stdout.strip().splitlines()[-1])
except (ValueError, IndexError):
    print('Preview capture failed:\\n' + (result.stderr or result.stdout)[-2000:], file=sys.stderr); sys.exit(1)
print('Preview: ' + manifest['status'] + (': ' + manifest['reason'] if manifest['reason'] else ''))
for page in manifest['pages']:
    print('  %s HTTP %s %s%s' % (page['url'], page['status'], os.path.join(out, page['screenshot']) if page['screenshot'] else '(no screenshot)', ' error: ' + page['error'] if page['error'] else ''))
for step in manifest['flow']:
    print('  step %s: %s%s' % (step['step'], 'ok' if step['ok'] else 'FAILED ' + step['error'], ' ' + os.path.join(out, step['screenshot']) if step.get('screenshot') else ''))
if manifest.get('video'): print('  recording: ' + os.path.join(out, manifest['video']['file']))
if manifest.get('cli'): print('  output (exit %s): %s' % (manifest['cli']['exitCode'], os.path.join(out, manifest['cli']['file'])))
if os.path.exists(os.path.join(out, 'app.log')): print('  app log: ' + os.path.join(out, 'app.log'))
print('Plan saved to ' + PLAN + '. At pull request handoff the harness captures again from the pushed commit and links the result from the description; these preview files are not used.')
sys.exit(0 if manifest['status'] == 'captured' else 1)
`;
