# OpenCode GitHub Bot execution plan

## Goal

Build a small, durable GitHub bot that runs OpenCode conversations in response
to pull-request comments.

The bot has two kinds of conversations:

1. All top-level comments on one pull request share one OpenCode session.
2. Each inline pull-request review thread has its own OpenCode session. Replies
    continue the session belonging to the root inline comment.

The first deployment target is exe.dev. The implementation remains a single
TypeScript/Effect application with SQLite durability and persistent filesystem
state.

## Non-goals

- iMessage, macOS Messages, collectors, Gmail, Calendar, personal data, or notes.
- Cloudflare Workers, Durable Objects, Modal, launchd, or Mac-native processes.
- General scheduling, reminders, webhooks unrelated to GitHub, or automations.
- Multiple model providers, profile systems, onboarding, or account catalogs.
- A generic integration framework. GitHub and OpenCode are explicit services.

## External behavior

### Top-level pull-request comments

Every eligible top-level comment on a pull request maps to:

```text
github:<installation-id>:<repository-id>:pull:<pull-number>:conversation
```

The session retains all prior eligible top-level comments and bot replies for
that pull request.

### Inline review threads

A new standalone inline review comment starts a conversation keyed by its root
review-comment ID:

```text
github:<installation-id>:<repository-id>:pull:<pull-number>:review:<root-comment-id>
```

A reply follows `in_reply_to_id` to the persisted root comment. If a parent is
not yet known locally, the bot fetches the bounded parent chain from GitHub and
persists the resolved root before acknowledging the event.

Line movement, outdated diffs, file renames, and review submission IDs do not
change the conversation key.

### Initial trigger policy

The first version processes:

- A non-bot comment containing the configured bot mention.
- A non-bot reply in an inline thread already owned by the bot.

Bot-authored comments and webhook deliveries already recorded by delivery ID are
ignored. Editing and deletion events are recorded but do not create a new model
turn in the first version.

## Durable execution model

```text
GitHub webhook
    -> authenticate signature
    -> persist delivery and normalized input
    -> acknowledge HTTP request
    -> serialize work by conversation key
    -> admit input to its persistent OpenCode session
    -> persist completed reply
    -> submit GitHub comment
    -> reconcile ambiguous submission by stable hidden marker
```

No network work occurs inside a SQLite transaction. Effect queues and fibers only
coordinate active work; SQLite and OpenCode storage remain authoritative after a
restart.

### Required SQLite state

#### `webhook_delivery`

- GitHub delivery ID, event type, received time, and processing state.
- Normalized routing metadata and a bounded reference to the durable input.
- Unique delivery ID for replay deduplication.

#### `conversation`

- Stable conversation key.
- GitHub installation, repository, pull request, and thread-root identifiers.
- Persistent OpenCode session ID.
- Persistent workspace ID and current active turn.
- Created and updated timestamps.

#### `comment`

- GitHub comment ID and kind: top-level or inline review comment.
- Conversation key and resolved root review-comment ID.
- Author type, creation time, and durable input ID.
- No duplicate copy of content after OpenCode has durably admitted it unless
    needed for a pending retry.

#### `inbox`

- Stable input ID derived from GitHub delivery and comment IDs.
- Persisted normalized prompt, status, attempt count, and OpenCode turn ID.
- States: `pending`, `admitted`, `complete`, `failed`, `unknown`, `cancelled`.

#### `outbox`

- Stable reply ID, destination, body, and hidden reconciliation marker.
- States: `queued`, `submitting`, `submitted`, `unknown`, `failed`.
- GitHub comment ID after confirmed submission.

### Lost-wake recovery

At startup and after each durable state change:

1. Requeue every pending inbox item using its existing stable ID.
2. Inspect admitted OpenCode turns through public SDK APIs.
3. Resume completed replies without asking the model again.
4. Mark interrupted side-effecting operations honestly as unknown.
5. Reconcile unknown GitHub submissions before any retry.

### GitHub reply reconciliation

Every bot reply ends with a hidden marker:

```html
<!-- opencode-github-bot:reply:<stable-reply-id> -->
```

If the process loses the HTTP result after submission, it searches the bounded
destination comment set for that exact marker. It records the existing GitHub
comment when found and only retries when absence is established.

## OpenCode model

- One persistent OpenCode session per durable GitHub conversation key.
- One active turn at a time within a session.
- Different GitHub conversations may execute concurrently with a configured
    global bound.
- Session history survives service restart.
- The system prompt includes repository, pull-request, and thread metadata but
    does not inject credentials.
- GitHub tokens are held by the control process and never returned to the model.

## Repository workspaces

Each conversation receives a persistent isolated workspace:

```text
/workspaces/<opaque-conversation-id>
```

The initial implementation uses an unprivileged Linux user and Unix socket per
workspace, retaining the proven workspace-driver boundary from Moldspoon.

Repository preparation is explicit:

1. Authenticate as the GitHub App installation in the control process.
2. Fetch the pull request's repository and head/base refs.
3. Prepare or refresh the conversation workspace without putting credentials in
    Git configuration, environment variables, or model-visible files.
4. Expose `/workspace` to that conversation's OpenCode instance.

The first version may read and modify its isolated checkout but does not push,
merge, approve, dismiss reviews, or create pull requests. Those capabilities
require separate authorization and design.

## Minimal application structure

```text
src/
    main.ts                 process entrypoint
    config.ts               strict environment/private-file configuration
    server.ts               health and GitHub webhook HTTP routes
    github/
        auth.ts             webhook and GitHub App authentication
        client.ts           narrow GitHub API operations
        events.ts           payload decoding and normalization
        threads.ts          top-level/inline conversation-key resolution
        delivery.ts         durable reply submission and reconciliation
    conversations/
        repository.ts       SQLite conversation/inbox/outbox state
        service.ts          serialized durable drive loop
        recovery.ts         restart and lost-wake recovery
    agent/
        host.ts             embedded OpenCode lifecycle
        sessions.ts         persistent session/turn projection
        workspace-driver.ts OpenCode workspace transport
    workspace/
        server.ts           unprivileged workspace process
        protocol.ts         bounded socket contract
test/
    github-events.test.ts
    thread-routing.test.ts
    durable-recovery.test.ts
    delivery-reconcile.test.ts
    agent-session.test.ts
deploy/
    exe/
        deploy.ts
        service.unit
        workspace@.service
        workspace@.socket
```

## Code retained from Moldspoon

Only code that directly supports these boundaries will be retained and renamed:

- HTTP server, strict configuration, release entrypoint, and production build
    patterns from `apps/exe-control`.
- OpenCode host, turn projection, stable prompt admission, and stale-turn
    recovery from `apps/exe-agent`.
- Runtime conversation registry patterns from `apps/exe-runtime`.
- Durable inbox/outbox and receipt state patterns from `apps/exe-bridge`.
- Restricted workspace server and driver from `apps/exe-workspace`.
- exe.dev build/release safety from `deploy/exe` and `deploy/exe-app`.
- Minimal Effect schemas required by those components.

No component is retained solely to avoid rewriting imports.

These source directories are transitional. After their required code has moved
into the final `src/` tree, delete the original `apps/exe-control`,
`apps/exe-agent`, `apps/exe-runtime`, `apps/exe-bridge`, and `apps/exe-workspace`
package directories. The finished repository does not retain the Moldspoon
`apps/exe-*` package layout.

## Deletion manifest

Delete these application trees after the minimal replacements compile:

- `apps/bridge`
- `apps/cloud`
- `apps/collector`
- `apps/exe-audit`
- `apps/exe-automations`
- `apps/exe-data`
- `apps/exe-gmail`
- `apps/exe-scheduler`
- `apps/exe-tools`
- `apps/operator`
- `apps/workspace`

Delete these transitional application trees after their GitHub-bot replacements
have been extracted into `src/`:

- `apps/exe-control`
- `apps/exe-agent`
- `apps/exe-runtime`
- `apps/exe-bridge`
- `apps/exe-workspace`

Delete these shared packages after required schemas are moved into the application:

- `packages/client`
- `packages/local-files`
- `packages/macos-messages`
- `packages/modal-sockets`

Delete or replace:

- Moldspoon-specific portions of `packages/contracts`.
- iMessage-specific portions of `apps/exe-bridge`.
- Account, Browser Control, SSH Control, MCP, personal-data, and profile code in
    `apps/exe-agent`, `apps/exe-runtime`, and `apps/exe-tools`.
- `deploy/launchd`, `deploy/exe-dev`, and Moldspoon-specific thread mounts.
- `examples`, old integration tests, historical Moldspoon documentation, and
    obsolete scripts.
- The existing root README, package graph, lockfile, AGENTS instructions, and
    configuration after their replacements exist.

## Implementation phases

### Phase 1: establish the minimal skeleton

1. Create the single application package and strict configuration schema.
2. Add health and authenticated GitHub webhook endpoints.
3. Add fixture-only GitHub event decoders and thread-key resolution.
4. Create the SQLite schema and migrations.

Acceptance:

- Duplicate webhook deliveries create one inbox item.
- Top-level and inline fixtures resolve to the expected stable keys.
- Invalid signatures and unsupported events are rejected or ignored safely.

### Phase 2: durable OpenCode conversations

1. Extract the embedded OpenCode host and SQLite-backed SDK configuration.
2. Persist one OpenCode session ID per conversation key.
3. Serialize turns per conversation and bound global concurrency.
4. Implement startup recovery using stable input IDs.

Acceptance:

- Two top-level comments on one PR reuse one session.
- Two inline threads use different sessions.
- Replies in one inline thread reuse its root session.
- Restart after admission does not duplicate the model prompt.

### Phase 3: repository workspaces

1. Extract the workspace socket protocol and unprivileged server.
2. Provision an opaque persistent workspace per conversation.
3. Add credential-free GitHub App checkout preparation.
4. Connect OpenCode native file/process tools through the workspace driver.

Acceptance:

- Conversation workspaces are persistent and mutually unreadable.
- A model cannot read GitHub App credentials or another thread's workspace.
- Restart preserves files and repository state.

### Phase 4: durable GitHub replies

1. Persist completed model output before submission.
2. Post top-level or inline replies to the correct destination.
3. Add hidden stable markers and unknown-outcome reconciliation.
4. Ignore bot-authored webhook echoes.

Acceptance:

- Lost HTTP responses do not create duplicate comments.
- A crash before submission retries the existing outbox item.
- A crash after confirmed submission does not resubmit.
- Inline replies remain in the correct review thread.

### Phase 5: remove Moldspoon

1. Delete the manifest above.
2. Flatten the remaining package graph.
3. Regenerate the lockfile from the minimal dependency set.
4. Replace README, AGENTS, architecture, and operations documentation.
5. Run repository-wide searches for Moldspoon, iMessage, Cloudflare, Modal,
    Gmail, collector, Browser Control, and personal-data remnants.

Acceptance:

- Only the GitHub/OpenCode application, tests, and exe.dev deployment remain.
- A clean install, typecheck, lint, tests, and production build pass.

### Phase 6: exe.dev rollout

1. Build a data-free release artifact.
2. Provision private GitHub App and OpenCode credentials outside the release.
3. Install the systemd control and workspace units.
4. Run synthetic webhook and restart-recovery checks.
5. Enable the GitHub App webhook only after synthetic acceptance.

Acceptance:

- Health and authenticated synthetic webhook checks pass.
- A real test PR proves top-level and two independent inline sessions.
- Restart recovery and reply reconciliation pass without duplicate comments.

## Required configuration

- Public HTTPS origin and listen address.
- GitHub App ID.
- GitHub webhook secret private-file path.
- GitHub App private-key private-file path.
- GitHub bot login used for trigger and echo filtering.
- OpenCode provider connection/state directory and selected model.
- SQLite state path and workspace root.
- Maximum global concurrent turns.

Secrets remain outside Git, release archives, logs, model context, and workspace
files.

## Test strategy

- Synthetic GitHub payload fixtures only until explicit live authorization.
- Fast unit tests for routing, schemas, deduplication, and reconciliation.
- Integration tests use a fake GitHub HTTP server and synthetic OpenCode model.
- Process restart tests exercise persisted inbox/outbox/session state.
- No coverage quota or exhaustive framework; test the durable boundaries.

## First implementation decision

Begin by creating the new skeleton alongside the inherited code. Extract and test
one durable boundary at a time. Delete the inherited directories only after the
replacement passes its focused tests, keeping every intermediate commit buildable.
