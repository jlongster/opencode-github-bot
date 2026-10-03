# OpenCode GitHub Bot

A small GitHub App bot that answers pull-request and issue comments with durable
[OpenCode](https://opencode.ai) conversations, built on the published
`@opencode/sdk` 2.x with TypeScript, Effect 4 and SQLite. It runs on exe.dev.

- All top-level comments on a pull request or issue share one OpenCode session.
- Each inline review thread has its own session; replies continue it.
- Webhooks are persisted before acknowledgement; turns and replies survive
  restarts; ambiguous GitHub submissions are reconciled by a hidden marker.
- Model tools run in a private, persistent workspace per conversation with
  the pull request (or, for issues, the default branch) checked out. GitHub
  credentials never enter it.

## Development

```sh
bun install
bun run check    # lint, typecheck, tests, production build, smoke test
```

Tests use synthetic webhooks, a fake GitHub server and OpenCode's scripted
test model. They never contact GitHub or a model provider.

## Layout

```text
src/
    main.ts                 control-service entrypoint
    config.ts               environment and private secret files
    server.ts               /health and /github/webhook
    github/                 auth, REST client, events, thread keys,
                            reply delivery, checkout
    conversations/          SQLite repository, routing, serialized drive loop
    agent/                  embedded OpenCode host and workspace driver
    workspace/              per-conversation executor, protocol, provisioning
test/                       synthetic acceptance tests
deploy/exe/                 systemd units, host setup and release script
```

See [docs/architecture.md](docs/architecture.md) and
[docs/operations.md](docs/operations.md).
