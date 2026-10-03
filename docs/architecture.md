# Architecture

## Flow

```text
POST /github/webhook
    -> verify X-Hub-Signature-256 over the exact body
    -> record delivery (unique delivery ID) with the normalized comment
    -> 202 only after the SQLite write
    -> wake the drive loop
router (single fiber, arrival order)
    -> resolve conversation key; inline replies resolve their thread root
       locally, else via a bounded GitHub parent-chain lookup
    -> one transaction: comment row, conversation, inbox item
per-conversation worker (bounded globally)
    -> ensure workspace + refresh checkout
    -> OpenCode turn with a stable message ID
    -> one transaction: finish inbox item, queue outbox reply
    -> submit reply; reconcile ambiguous outcomes by marker
```

Routing happens after acknowledgement so a webhook response never waits on
GitHub. The delivery row is durable before the 202, so nothing is lost.

## Conversation keys

```text
github:<installation>:<repository>:pull:<number>:conversation
github:<installation>:<repository>:pull:<number>:review:<root-comment-id>
github:<installation>:<repository>:issue:<number>:conversation
```

Keys use stable IDs only. A comment starts a turn when it mentions
`@<app-slug>`, or when it is an inline reply in a thread the bot already owns.
Only users on the `GITHUB_ALLOWED_USERS` allowlist (numeric GitHub user IDs,
which unlike logins cannot be reclaimed) can trigger the bot; everyone else is
ignored, including in threads the bot already owns. Bot-authored comments,
comments containing the reply marker, edits, deletions, closed pull requests
and issues, and other installations are also ignored.

## Durability

SQLite (`bot.sqlite`, WAL, `synchronous=FULL`) is authoritative; Effect
queues and fibers only coordinate active work. Transactions are synchronous
and contain no I/O.

| Table              | Purpose                                                                         |
| ------------------ | ------------------------------------------------------------------------------- |
| `webhook_delivery` | Replay deduplication; normalized payload until routed, then cleared             |
| `conversation`     | Key, GitHub identifiers, OpenCode session ID, workspace ID                      |
| `comment`          | Seen comments and resolved inline roots                                         |
| `inbox`            | One item per triggering comment (`<kind>-comment:<id>`); prompt cleared on completion |
| `outbox`           | One reply per inbox item; body cleared once submitted                           |

Inbox: `pending → admitted → complete | failed`. Outbox:
`queued → submitting → submitted`, with `unknown` for ambiguous outcomes and
`failed` for definite rejections or exhausted attempts.

Recovery runs at startup and on every sweep (30 s): `submitting` becomes
`unknown`; pending/admitted inbox items and queued/unknown replies resume.

### OpenCode turns

The OpenCode SDK is used unmodified. Each turn:

1. creates the session and workspace idempotently;
2. prompts with message ID `msg_<sha256(inbox id)>` unless that message is
   already admitted, so retries and restarts never duplicate the prompt;
3. calls `sessions.wait`, then reads the assistant text between that message
   and the next `idle` marker (OpenCode's own synthetic restart notices belong
   to the turn).

OpenCode persists its sessions in `opencode.sqlite` and resumes interrupted
executions itself after restart. A failed or empty turn produces an honest
failure reply.

### Reply reconciliation

Every reply ends with `<!-- opencode-github-bot:reply:<inbox id> -->`. A
network error or 5xx leaves the reply `unknown`; the next attempt lists the
destination comments since the reply was queued and records an existing
comment, resubmitting only when the marker is proven absent. Delivery is
therefore at-least-once-attempted and never knowingly duplicated, not
exactly-once.

## Workspaces

Each conversation has an opaque ID (`sha256(key)[0:20]`), a Linux user
`ghb-<id>`, a `0700` directory `/workspaces/<id>`, and a socket-activated
executor that sees that directory as `/workspace`.

OpenCode's native tools (shell, read, write, edit, glob, grep) are routed by a
public `WorkspaceDriver` provider: the driver supplies only a process spawner,
and OpenCode's default file operations run through it. Only locale and
terminal environment variables cross the socket.

The model's tools are `shell`, `read`, `write`, `edit`, `glob`, `grep`,
`subagent` and `skill`. Agent permission rules remove `question` (nobody can
answer it on GitHub) and `execute`, `webfetch` and `websearch`, which would run
in the control process instead of the workspace.

The control process (user `ghbot`) cannot create users. It writes
`workspace-requests/<id>.request`; a root path unit runs `provision.sh`,
which creates the user, directory and socket (owned by `ghbot`, `0600`).

### Closed pull requests and issues

Comments on closed pull requests and issues are ignored. A daily systemd timer
(`opencode-github-bot-cleanup.timer`, `Persistent=true`) runs
`dist/cleanup.mjs` as `ghbot`. It asks GitHub's issues API (which covers pull
requests too) for the current state of every pull request and issue that still
has workspaces. For those closed more than seven days
it queues a `<id>.delete` request for each conversation's workspace, then marks
the conversation's workspace deleted. The root provisioning script processes
deletions before creations: it disables the socket and executor, kills the
user's processes, removes `ghb-<id>` and deletes `/workspaces/<id>`.

The running bot interrupts any turn still running in a conversation whose
workspace was just deleted, and sends no reply. Conversation records and
OpenCode sessions are kept for debugging. If it is reopened, the
next mention provisions a fresh workspace and checkout and continues the same
session, and the first prompt says the workspace was recreated. A thread whose
state lookup fails is retried on the next daily
run.

### Checkout

Before each turn the control process fetches `refs/pull/<n>/head` and the base
branch into a control-owned bare mirror, passing the installation token to
git only through `GIT_CONFIG_*` environment variables. It streams a
`git bundle` over the socket to a `git fetch` run by the workspace user, which
updates `pr/head` and `pr/base` in `/workspace/repo` and checks out
`pr-<n>` the first time. For an issue, the default branch is fetched instead
and checked out as `issue-<n>`, with `default` refreshed before each turn.
Local work is never reset.

The bot cannot push, merge, approve, dismiss reviews, create pull requests or
change issue state.

## Limitations

- Linux-user isolation is enforced by systemd and file modes in deployment;
  tests exercise the socket boundary but not separate users.
- Workspaces share VM CPU, memory and network.
- A comment's prompt is limited to 12,000 characters, replies to 60,000.
- Reconciliation searches up to 1,000 destination comments.
