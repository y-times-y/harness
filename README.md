# ytimesy harness

The open-source coding agent behind [ytimesy](https://ytimesy.com), the AI
software engineer in the cloud. Run it on your own computer with your own model
key, or let ytimesy run it for you.

**[Start building at ytimesy.com](https://ytimesy.com)** · **[Join us on Discord](https://discord.gg/Ks3frvJVUQ)**

## ytimesy in the cloud

ytimesy runs this harness on cloud machines, so the work happens while you do
something else:

- **Agents work in parallel**, each on its own machine. A lead agent splits the
  work and reviews each patch.
- **Tests in a real browser.**
- **Fixes failing checks on its own.**
- **Remembers how you work.**
- **Screenshots and video in your pull request.**
- **Bring your own model**, on the same harness.

Already working in Claude Code, Codex or Cursor? In ytimesy, choose "Continue
your agent session" and run the command it gives you; the `ytimesy` command
line in this repository moves your session and work in progress to the cloud.

## What is in this repository

Two MIT-licensed packages.

| Package | What it is |
| --- | --- |
| [`@ytimesy/harness`](packages/harness) | The ytimesy coding agent as a standalone local engine. It runs on your computer with your own model API key (Anthropic, OpenAI, Google or OpenRouter) and talks only to that provider. No ytimesy account or server is involved. |
| [`ytimesy`](packages/ytimesy-cli) | A command line that moves your local coding-agent sessions (Claude Code, Codex, Cursor and more) to your ytimesy account. It talks to ytimesy.com by design: that hand-off is its whole purpose. |

```sh
npx @ytimesy/harness "Find why the date parser rejects 2026-02-29 and fix it"
```

## Benchmark

![ytimesy scores 58.5% on Terminal-Bench 4.0 with GPT-6 Astra xhigh, against Codex at 58.2% (Astra max) and 57.9% (Astra xhigh)](packages/harness/docs/terminal-bench-4.jpg)

Terminal-Bench 4.0, GPT-6 Astra in every column, all 66 tasks, five attempts
each. The full table, intervals, cost, time and public Harbor jobs are in the
[harness README](packages/harness/README.md#benchmark) and the write-up
[Introducing ytimesy harness 1.0](https://ytimesy.com/blog/harness-1-0).

## How it works

![The lead agent and its tools: files and shell, code mode, subagents and web and plan, with background commands below](packages/harness/docs/harness-tools.svg)

The [harness README](packages/harness/README.md#how-it-works) explains the tools, code mode and the clean-copy check with diagrams. The dimmed Subagents box is the hosted product's delegation, which these packages do not include.

## Develop

Node.js 22.13 or newer and pnpm.

```sh
pnpm install
pnpm typecheck
pnpm test
pnpm build
```

`pnpm build` writes `packages/harness/dist/ytimesy-harness.mjs` and
`packages/ytimesy-cli/dist/ytimesy.mjs`.

## License

MIT, see [LICENSE](LICENSE). The ytimesy name and logo are not licensed under MIT.
