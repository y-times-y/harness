import { posixShellCommand } from "../../domain/posix-command";
import { repositoryToolPath } from "./repository-tool-path";

const INSPECT = `import os, pathlib, shutil, subprocess, sys, tempfile
root = pathlib.Path(sys.argv[1]).resolve(strict=True)
scope = sys.argv[2]
diff_view = ['--stat'] if sys.argv[3] == 'stat' else []
if not (root / scope).resolve().is_relative_to(root):
    raise ValueError('Inspection scope escaped repository')
git = ['git', '--literal-pathspecs', '-C', str(root), '-c', 'core.fsmonitor=false', '-c', 'core.hooksPath=/dev/null']
environment = dict(os.environ, GIT_OPTIONAL_LOCKS='0')
# Inspection must not execute repository-configured conversion programs.
configured = subprocess.run(git + ['config', '--name-only', '--get-regexp', r'^filter\\..*\\.(clean|smudge|process|required)$'], env=environment, capture_output=True, timeout=20)
if configured.returncode not in (0, 1): raise RuntimeError('Filter configuration unavailable')
for driver in sorted(set(key.rsplit('.', 1)[0] for key in configured.stdout.decode().splitlines())):
    for setting in ('clean=', 'smudge=', 'process=', 'required=false'):
        git += ['-c', driver + '.' + setting]
for arguments in (['status', '--short', '--untracked-files=all'], ['diff', '--cached', '--no-ext-diff', '--no-textconv', '--find-renames'] + diff_view):
    subprocess.run(git + arguments + ['--', scope], env=environment, check=True, timeout=20)
files = subprocess.check_output(git + ['ls-files', '--others', '--exclude-standard', '-z', '--', scope], timeout=20).decode().split('\\0')
regular = []
for filename in files:
    if not filename: continue
    path = root / filename
    if path.is_symlink() or not path.resolve().is_relative_to(root) or not path.is_file():
        print('Untracked path not read (symlink or non-regular file): ' + filename, flush=True)
        continue
    regular.append(filename)
index = subprocess.check_output(git + ['rev-parse', '--git-path', 'index'], env=environment, timeout=20).decode().strip()
index = pathlib.Path(index) if pathlib.Path(index).is_absolute() else root / index
with tempfile.TemporaryDirectory(prefix='ytimesy-inspect-') as temporary:
    private_index = pathlib.Path(temporary) / 'index'
    if index.exists(): shutil.copyfile(index, private_index)
    private_environment = dict(environment, GIT_INDEX_FILE=str(private_index))
    if regular:
        subprocess.run(git + ['add', '--intent-to-add', '--pathspec-from-file=-', '--pathspec-file-nul'], input=('\\0'.join(regular) + '\\0').encode(), env=private_environment, check=True, timeout=20)
    subprocess.run(git + ['diff', '--no-ext-diff', '--no-textconv', '--find-renames'] + diff_view + ['--', scope], env=private_environment, check=True, timeout=20)`;

/** A disposable index lets Git detect unstaged renames, retaining staged evidence without altering the real index. */
export function inspectRepositoryChangesCommand(
	directory: string,
	path = ".",
	view: "full" | "stat" = "full",
) {
	return posixShellCommand([
		"python3",
		"-c",
		INSPECT,
		directory,
		repositoryToolPath.parse(path),
		view,
	]);
}
