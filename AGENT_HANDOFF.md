# Agent handoff: OpenCode GitHub Bot

## Current state

All Moldspoon code has been replaced by a single application under `src/`
built on the published `@opencode/sdk` / `@opencode/core` 2.0.22 (unmodified;
`@opencode/ai` for the test model). `bun run check` runs lint, typecheck, the
synthetic acceptance tests, the production build and a bundle smoke test.

- Deployment target: exe.dev. Primary working directory:
    `/root/projects/opencode-github-bot` on `jamesbox.exe.xyz`.
- No Git remote is configured.
- Live on VM `opencode-github-bot` (exe.dev, NYC, 2 CPU / 8 GB / 25 GB) from
    `ghcr.io/anomalyco/devbox@sha256:182c7b242ab79c85bbe477dc7ea58574fca0865fcc3467faa627dc8a1140bb5b`
    (verified against the registry), with Bun 1.4.2 at `/usr/local/bin/bun`.
    Proxy: public, port 8080 (`https://opencode-github-bot.exe.xyz`).
- Test GitHub App `opencode-bot-jlongster` (ID 5169826), installed only on the
    private repo `jlongster/opencode-github-bot-test` (installation 167373253).
    Its key and webhook secret were created on the VM via the manifest flow.
- Model `opencode/claude-opus-5-5` through the Anomaly org's OpenCode Console
    credential, copied by James's request from his local OpenCode state with
    `import-credential`. Both installs share one refresh token; re-import or
    sign in again if either is signed out.
- Verified live on test PR #1: a top-level review, two independent inline
    threads, and a mention-free reply continuing its thread's session. Separate
    Linux users and `0700` workspaces per conversation; workspace users cannot
    read other workspaces or the app key; the checkout has no remotes or
    credentials.

How it works: `docs/architecture.md`. How to run it: `docs/operations.md`.
`EXECUTION_PLAN.md` is the original plan; deviations are listed below.

## Product definition

Create a simple GitHub App bot that receives pull-request comments and responds
using durable OpenCode conversations.

The bot is intentionally narrow:

```text
GitHub webhook
    -> durable inbox
    -> conversation-specific OpenCode session
    -> durable reply outbox
    -> GitHub comment
```

The word "simple" means few explicit services and no generic connector platform.
It does not mean stateless. Durable admission, recovery, deduplication, and honest
external-delivery outcomes are core requirements.

## Exact conversation semantics

### Top-level pull-request conversation

All eligible top-level comments in one pull request share one OpenCode session:

```text
github:<installation-id>:<repository-id>:pull:<pull-number>:conversation
```

### Inline review conversations

Each independent inline review thread gets its own OpenCode session:

```text
github:<installation-id>:<repository-id>:pull:<pull-number>:review:<root-comment-id>
```

- A new inline comment starts a session.
- Replies reuse the session belonging to the root inline comment.
- Persist parent-to-root resolution.
- If a parent is absent locally, fetch a bounded parent chain from GitHub.
- Outdated diffs, moved lines, and renamed files do not change the key.

GitHub's main PR conversation has no nested comment threading. Therefore all
top-level PR comments intentionally share one session.

## Initial trigger policy

Process:

- Non-bot comments containing the configured bot mention.
- Non-bot replies in an inline thread already owned by the bot.

Ignore:

- Bot-authored webhook echoes.
- Duplicate GitHub delivery IDs.
- Unsupported repositories or installations.
- Edited/deleted comments as new turns in the first version.

Keep trigger policy explicit and easy to change; do not build a rule engine.

## Durability contract

### Inbound

1. Verify the GitHub webhook signature and bounded payload.
2. Normalize repository, PR, comment, author, and thread metadata.
3. Persist the delivery and inbox item transactionally.
4. Return the webhook response only after persistence.
5. Queue active processing from durable state.

Stable GitHub delivery/comment IDs must prevent duplicate model prompts.

### Model execution

1. Resolve or create the conversation record.
2. Resolve or create its persistent OpenCode session.
3. Admit the prompt using a stable input ID.
4. Serialize turns for that session.
5. Persist the completed reply before delivery.

On restart, inspect OpenCode through public SDK APIs and resume the existing turn
or completed output. Never reconstruct a claim that an interrupted side effect
succeeded.

### Outbound

Every reply has a stable ID and hidden marker:

```html
<!-- opencode-github-bot:reply:<stable-reply-id> -->
```

If GitHub submission becomes ambiguous, search the bounded destination comments
for that marker before retrying. Record `unknown` when absence cannot be proven.

## Workspace model

Start with one persistent isolated workspace per GitHub conversation. Retain the
proven unprivileged-user and Unix-socket execution boundary from Moldspoon.

- Workspace path: `/workspaces/<opaque-conversation-id>`.
- OpenCode sees it as `/workspace`.
- Different conversations cannot read each other's workspaces.
- GitHub App credentials remain in the control process.
- Repository checkout/fetch must not leave credentials in Git config, environment,
    command arguments visible to the model, or workspace files.

The first version may inspect and modify its isolated checkout. It must not push,
merge, approve, dismiss reviews, or create pull requests.

## Implementation status

Phases 1–5 of `EXECUTION_PLAN.md` are implemented; Phase 6 (live rollout) is
prepared but not started.

Covered by synthetic tests (`test/`):

- Signature rejection, unsupported events, replayed deliveries (one inbox item,
    one reply), bot echoes and edits ignored.
- One session for top-level comments; separate sessions per inline thread;
    replies reuse the root's session; unknown parents resolved via GitHub.
- Restart after admission resumes without re-prompting; restart after
    completion delivers persisted output without a model call; session history
    survives restart; confirmed replies are never resubmitted.
- Lost GitHub responses reconciled by marker without duplicates.
- Native OpenCode tools run over the per-conversation socket in separate
    workspaces; the control environment does not leak into workspace processes.
- PR checkout via bundle with no remotes or credentials in the workspace;
    refs refresh while local work is kept.

Deviations from the plan:

- Routing (including inline-root lookups) runs after the delivery is durably
    recorded and acknowledged, so webhook responses never wait on GitHub.
- Repository/PR/thread metadata is placed in each prompt rather than a
    per-session system prompt.
- Inbox states are `pending/admitted/complete/failed`; outbox adds `unknown`.
    Unused `cancelled` states were not added.
- The deployment is a small `deploy/exe` (units, host setup, release script)
    rather than Moldspoon's VM-image tooling.

## Remaining work

- Live restart-recovery and reconciliation checks on the VM (covered only by
    synthetic tests so far).
- Installing the app beyond the test repository requires James's approval.
- Closed pull requests: comments are ignored; a daily systemd timer deletes
    workspaces (Linux user, executor, directory) of pull requests closed over
    seven days and interrupts any turn still using them, keeping conversation
    records and sessions. Root deletion and re-provisioning were verified live
    on a test workspace; the full seven-day path is covered by tests.

## Configuration still needed before live work

The implementation should define but not provision:

- GitHub App ID.
- GitHub App private-key path.
- Webhook secret path.
- Bot login and allowed repository/installation scope.
- Public HTTPS origin.
- OpenCode provider connection and model.
- SQLite and workspace paths.
- Global turn-concurrency limit.

Ask James before creating a GitHub App, adding credentials, installing a webhook,
accessing a private repository, or deploying live infrastructure.
