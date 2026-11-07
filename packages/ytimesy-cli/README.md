# ytimesy CLI

Continue your local coding-agent sessions (Claude Code, Codex, Cursor, Gemini
CLI, OpenCode, Pi, Grok) and your work in progress in the cloud, on
[ytimesy](https://ytimesy.com), the AI software engineer in the cloud. New to
ytimesy? [Start building](https://ytimesy.com).

## Quickstart

In ytimesy, open "Continue your agent session", copy the prompt and paste it
into your local agent. It runs the CLI for you; you can also run it yourself:

```sh
npx -y ytimesy continue --code YTM-XXXX-XXXX-XXXX                   # plan only
npx -y ytimesy continue --code YTM-XXXX-XXXX-XXXX --scope session   # import
```

Requires Node.js 22.13+ (older Node skips OpenCode and Cursor sessions, with a
warning) and `git`. No telemetry.

## Commands

The only command is `ytimesy continue`; `ytimesy --help` lists every flag.

| Invocation | What it does |
| --- | --- |
| `continue --code <code>` | Plan only: detects the current session, lists the scopes and folders, uploads nothing. |
| `continue --code <code> --scope <s>` | Imports. `session` (default) is this session, `project` every session of this repository, `machine` every session on this computer. |
| `continue --code <code> --cancel` | Stops the import; the ytimesy card stops waiting. |
| `--plan` | Prints the plan for `--scope` without importing. |
| `--create-repo <folder>=<name>` | Creates a private GitHub repository for a folder that has none, with your own `gh` login, and pushes the folder to it. |
| `--attach <folder>=<project>` | Imports a folder's sessions into an existing ytimesy project. |
| `--skip <folder>` | Leaves a folder out. |
| `--yes-untracked` / `--no-untracked` | Pushes the untracked files the plan lists / tracked changes only. |
| `--yes-public` | Allows untracked files in a public repository. |
| `--secrets A,B` / `--no-secrets` | Uploads only these `.env` names as project secrets / none. |
| `--json` | Prints the result as JSON (progress goes to stderr). |
| `--api <url>` | ytimesy server (default `https://ytimesy.com`). |

Exit codes: 0 done (or plan printed), 1 failed, 2 usage error, 3 needs your
decision (the output names the flag to add).

## The continue-in-cloud flow

1. ytimesy shows a one-time code. The CLI exchanges it for an import token
   that lasts 2 hours.
2. The CLI detects your local session and prints a plan. Nothing is uploaded
   yet.
3. With `--scope`, it pushes your current work, uncommitted changes included,
   to a new `ytimesy/...` branch using your own Git credentials. Your working
   tree, index and current branch are never changed.
4. It uploads the sessions (values from `.env` and `.env.local` are redacted),
   saves the `.env` names you chose as project secrets, and prints the link
   that opens the chat in ytimesy.

Re-running the same command resumes: finished steps are skipped.

## Configuration

| Variable | Meaning |
| --- | --- |
| `YTIMESY_API` | Server to talk to when `--api` is not given (default `https://ytimesy.com`). |
| `YTIMESY_STATE_DIR` | Where import progress is saved. Default `~/.ytimesy/cli/imports`, then the temp directory. |
| `GIT_AUTHOR_NAME`, `GIT_AUTHOR_EMAIL` | Author of the work-in-progress commit when git has no identity configured. |

## Build and test

From the repository root:

```sh
pnpm install
node packages/ytimesy-cli/build.mjs               # bundles dist/ytimesy.mjs
pnpm exec vitest run packages/ytimesy-cli
```

The CLI reuses the session readers in `src/local-sessions` and the import
types in `src/domain` of the main repository, and the build bundles them into
one file.

## License

[MIT](LICENSE). The ytimesy name and logo are not licensed under MIT.
