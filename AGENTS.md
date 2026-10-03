# OpenCode GitHub Bot

Build a small, durable GitHub bot backed by persistent OpenCode conversations.
Moldspoon was the source material; all inherited code has now been replaced
and deleted.

## Start here

Read these files before implementation:

1. `AGENT_HANDOFF.md` — current decisions, boundaries, and state.
2. `docs/architecture.md` and `docs/operations.md` — how the bot works and runs.
3. `EXECUTION_PLAN.md` — the original phased plan.

## Product boundary

- Receive authenticated GitHub App webhooks for pull-request comments.
- Persist webhook work before acknowledging it.
- Give each GitHub comment thread a durable OpenCode conversation/session.
- Persist model turns and GitHub reply delivery across restart.
- Run on exe.dev.
- Use TypeScript and Effect 4. Do not author Python.

No iMessage, Mac bridge, collectors, Gmail, Calendar, personal data, Cloudflare,
Modal, Browser Control, SSH Control, automations, scheduling, or generic connector
framework belongs in the finished project.

## Conversation mapping

- All top-level comments on one pull request share one session.
- Each root inline pull-request review comment starts a separate session.
- Replies to an inline review comment reuse the root comment's session.
- Use stable GitHub installation, repository, pull-request, and root-comment IDs.
- Never key conversations by text, file path, line number, or diff position.

## Reliability rules

- Persist input before webhook acknowledgement.
- Use stable IDs and uniqueness constraints for webhook, prompt, and reply dedup.
- Serialize turns within one conversation; bound concurrency across conversations.
- Treat Effect queues/fibers as active coordination, never durable work.
- Keep SQLite transactions synchronous and free of external I/O.
- Recover pending/admitted work after restart through public OpenCode APIs.
- Reconcile ambiguous GitHub comment submissions using a stable hidden marker.
- Preserve honest `unknown` outcomes; do not claim exactly-once external delivery.
- Keep GitHub and model credentials outside Git, logs, prompts, and workspaces.

## Implementation approach

- Keep every commit buildable and covered by focused tests (`bun run check`).
- Prefer explicit GitHub/OpenCode services over reusable integration frameworks.
- Use the latest published OpenCode v2 packages (`@opencode/sdk`, `@opencode/core`,
    `@opencode/ai`) exactly as published. Never patch or fork OpenCode; work
    within its public APIs and adapt this repository instead.
- Model tools use OpenCode's native tools through the per-conversation workspace
    driver, not a custom tool catalog.

## Safety

- Synthetic fixtures only until James explicitly approves GitHub App credentials,
    live webhook installation, repository access, and deployment.
- Do not read credentials, `.env` files, personal databases, or old Moldspoon
    production state.
- Do not mutate `/Users/james/projects/moldspoon`; it is a separate live project.
- Do not deploy or create a GitHub App as an inferred next step.
- Never put secrets, private repository content, prompts, or provider responses in
    fixtures, logs, commits, or handoff documents.

## Quality

- Keep the implementation small and readable.
- Test core durability, routing, authorization, isolation, and reconciliation.
- Avoid exhaustive edge-case matrices, coverage quotas, and speculative abstractions.
- Run formatting, lint, typecheck, focused tests, and production build before handoff.
- Record meaningful architecture or operational changes in concise current docs;
    do not recreate Moldspoon's large historical handoff archive.

## Repository locations

- Primary exe.dev workspace copy: `/root/projects/opencode-github-bot` on
    `jamesbox.exe.xyz`.
- Local staging copy: `/Users/james/projects/opencode-github-bot`.
- Public repository: https://github.com/jlongster/opencode-github-bot (`origin`).
