import { projectSourceEvidence } from "../../domain/project-source-evidence";
import type { AgentToolWorkspace } from "./agent-tool-workspace";

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const EVIDENCE_SCRIPT = `import hashlib, json, pathlib, subprocess, sys
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
paths = json.loads(sys.argv[2])
include_untracked = sys.argv[3] == '1'
sources = []
for filename in paths:
    path = pathlib.Path(filename)
    record = {'path': filename, 'sha256': None}
    if not path.is_absolute() and '..' not in path.parts and '.git' not in path.parts and not any(part.startswith('.env') for part in path.parts):
        target = root / path
        tracked = subprocess.run(['git', '-C', str(root), 'ls-files', '--error-unmatch', '--', filename], capture_output=True, timeout=5)
        untracked = include_untracked and tracked.returncode != 0 and subprocess.run(['git', '-C', str(root), 'check-ignore', '-q', '--', filename], capture_output=True, timeout=5).returncode == 1
        if (tracked.returncode == 0 or untracked) and not target.is_symlink() and target.resolve().is_relative_to(root) and target.is_file():
            digest = hashlib.sha256()
            with target.open('rb') as handle:
                for chunk in iter(lambda: handle.read(65536), b''):
                    digest.update(chunk)
            record['sha256'] = digest.hexdigest()
    sources.append(record)
revision = subprocess.run(['git', '-C', str(root), 'rev-parse', 'HEAD'], capture_output=True, text=True, timeout=5)
status = subprocess.check_output(['git', '-C', str(root), 'status', '--porcelain', '--untracked-files=normal'], timeout=5)
print(json.dumps({'revision': revision.stdout.strip() if revision.returncode == 0 else None, 'dirty': bool(status.strip()), 'sources': sources}))`;

/** Source contents stay on the guest; the project stores only source pointers and hashes. */
export async function inspectProjectSourceEvidence(
	workspace: AgentToolWorkspace,
	sources: readonly string[],
	includeUntracked = false,
) {
	const paths = [
		...new Set(sources.map((source) => source.replace(/:\d+(?::\d+)?$/, ""))),
	].slice(0, 8);
	const result = await workspace.machines.exec(
		workspace.vm,
		`python3 -c ${quote(EVIDENCE_SCRIPT)} ${quote(workspace.cwd)} ${quote(JSON.stringify(paths))} ${includeUntracked ? 1 : 0}`,
		20_000,
	);
	if (result.exitCode)
		throw new Error(
			"Could not verify project source evidence against this checkout.",
		);
	return projectSourceEvidence.parse(JSON.parse(result.stdout));
}
