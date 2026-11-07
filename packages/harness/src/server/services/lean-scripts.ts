import { LOCKED_APPLY_EDIT } from "./api-agent-file-tools";

/**
 * The Python the lean engine (lean-engine.ts) runs on the workspace VM:
 * reading a file page, writing a file through the runtime's checked edit
 * function, and reading a command output file's tail.
 */

/** A file's page (or, in `full` mode, its whole UTF-8 text and hash); images as base64. */
export const READ_SCRIPT = String.raw`import base64, hashlib, json, os, sys
path, cwd, mode = os.path.expanduser(sys.argv[1]), sys.argv[2], sys.argv[3]
offset, limit, max_bytes, max_line = int(sys.argv[4]), int(sys.argv[5]), int(sys.argv[6]), int(sys.argv[7])
if not os.path.isabs(path): path = os.path.join(cwd, path)
path = os.path.normpath(path)
def out(value):
    print(json.dumps(dict(value, path=path), ensure_ascii=False)); sys.exit(0)
if not os.path.exists(path): out({'missing': True})
if os.path.isdir(path): out({'directory': True, 'entries': sorted(os.listdir(path))[:200]})
size = os.path.getsize(path)
with open(path, 'rb') as handle: head = handle.read(8192)
image = 'image/png' if head.startswith(b'\x89PNG') else 'image/jpeg' if head.startswith(b'\xff\xd8\xff') else 'image/gif' if head[:6] in (b'GIF87a', b'GIF89a') else 'image/webp' if head[:4] == b'RIFF' and head[8:12] == b'WEBP' else None
if mode == 'full':
    if size > 20000000: out({'error': 'File is larger than 20 MB'})
    raw = open(path, 'rb').read()
    try: content = raw.decode('utf-8')
    except UnicodeDecodeError: out({'error': 'File is not UTF-8 text'})
    out({'content': content, 'sha256': hashlib.sha256(raw).hexdigest()})
if image:
    if size > 5000000: out({'error': 'Image is larger than 5 MB'})
    out({'image': image, 'base64': base64.b64encode(open(path, 'rb').read()).decode(), 'bytes': size})
if b'\0' in head: out({'binary': True, 'bytes': size})
lines, used, total, cut = [], 0, 0, False
with open(path, encoding='utf-8', errors='replace', newline='') as handle:
    for line in handle:
        total += 1
        if total < offset or cut: continue
        if len(lines) >= limit: cut = True; continue
        text = line.rstrip('\r\n')
        if max_line and len(text) > max_line: text = text[:max_line] + '... [line truncated]'
        size_of = len(text.encode('utf-8')) + 1
        if used + size_of > max_bytes and lines: cut = True; continue
        lines.append(text); used += size_of
out({'lines': lines, 'totalLines': total, 'startLine': offset, 'cut': cut})`;

/**
 * Writes a whole file with the runtime's own edit function
 * (api-agent-file-tools.ts LOCKED_APPLY_EDIT): the repository's edit lock, no
 * .git, no symlinks, no escape from the root, stale-content refusal, atomic
 * replace with the temp file removed on failure. Lean tools take absolute
 * paths, so the path must fall under one of `roots` (the repository, and
 * ~/memory); it is made relative to that root first.
 * `expectedSha256`: absent overwrites whatever is there; null requires that
 * the file does not exist; a hash requires the file still has it.
 */
export const WRITE_SCRIPT = `import fcntl, hashlib, json, os, pathlib, stat, sys, tempfile
payload = sys.argv[1]
with open(payload, encoding='utf-8') as handle: spec = json.load(handle)
os.remove(payload)
path = os.path.normpath(os.path.join(spec['cwd'], os.path.expanduser(spec['path'])))
def out(value):
    print(json.dumps(dict(value, path=path), ensure_ascii=False)); sys.exit(0)
root = relative = None
for allowed in spec['roots']:
    base = os.path.normpath(os.path.expanduser(allowed))
    if not os.path.isdir(base): continue
    for prefix in dict.fromkeys((base, os.path.realpath(base))):
        if path.startswith(prefix + os.sep):
            root, relative = pathlib.Path(base).resolve(strict=True), path[len(prefix) + 1:]
            break
    if root: break
if root is None: out({'error': 'outside'})
${LOCKED_APPLY_EDIT}
target = root / relative
if target.is_dir() and not target.is_symlink(): out({'error': 'is a directory'})
data = spec['content']
if 'expectedSha256' in spec:
    expected = spec['expectedSha256']
elif target.is_file() and not target.is_symlink():
    with target.open('r', encoding='utf-8', newline='') as handle:
        expected = hashlib.sha256(handle.read().encode()).hexdigest()
else:
    expected = None
request = {'operation': 'create', 'path': relative, 'content': data} if expected is None else {'operation': 'write', 'path': relative, 'content': data, 'expectedSha256': expected}
try:
    apply_edit(request)
except (ValueError, UnicodeDecodeError, OSError) as error:
    message = str(error)
    stale = 'changed since inspection' in message or ('already exists' in message and 'expectedSha256' in spec)
    out({'error': 'stale' if stale else message})
encoded = data.encode('utf-8')
out({'created': expected is None, 'bytes': len(encoded), 'lines': encoded.count(b'\\n') + (0 if encoded.endswith(b'\\n') or not encoded else 1)})`;

/** A command output file's text from a character offset, its tail kept under a limit. */
export const TAIL_SCRIPT = String.raw`import json, sys
path, start, max_chars = sys.argv[1], int(sys.argv[2]), int(sys.argv[3])
try:
    with open(path, encoding='utf-8', errors='replace') as handle: text = handle.read()
except FileNotFoundError:
    text = ''
part = text[start:]
lines = part.count('\n') + (1 if part and not part.endswith('\n') else 0)
print(json.dumps({'text': part[-max_chars:], 'cut': len(part) > max_chars, 'lines': lines, 'end': len(text)}, ensure_ascii=False))`;

/** Absolute paths of rg's file list (stdin), at most 100, with a note when there were more. */
export const GLOB_RESULTS_SCRIPT = String.raw`import os,sys; lines=[os.path.abspath(l.rstrip('\n')) for l in sys.stdin]; print('\n'.join(lines[:100])); print('(Results are truncated: more than 100 files. Use a more specific path or pattern.)' if len(lines) > 100 else '', end='')`;
