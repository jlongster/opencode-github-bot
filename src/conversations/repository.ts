import { DatabaseSync, type SQLInputValue } from "node:sqlite";
import { Context, Effect, Layer, Schema } from "effect";

export class StorageError extends Schema.TaggedError<StorageError>()(
    "StorageError",
    { message: Schema.String },
) {}

export type CommentKind = "issue" | "review";

export type ConversationRow = {
    readonly key: string;
    readonly installationId: number;
    readonly repositoryId: number;
    readonly repository: string;
    readonly target: "pull" | "issue";
    /** Pull-request or issue number. */
    readonly number: number;
    readonly rootCommentId: number | null;
    readonly sessionId: string;
    readonly workspaceId: string;
    /** Set when the workspace was deleted after its pull request closed. */
    readonly workspaceDeletedAt: number | null;
};

export type InboxStatus = "pending" | "admitted" | "complete" | "failed";

export type InboxRow = {
    readonly id: string;
    readonly conversationKey: string;
    readonly messageId: string;
    readonly prompt: string | null;
    readonly status: InboxStatus;
};

export type OutboxStatus =
    | "queued"
    | "submitting"
    | "submitted"
    | "unknown"
    | "failed";

export type OutboxRow = {
    readonly id: string;
    readonly conversationKey: string;
    readonly kind: CommentKind;
    readonly body: string | null;
    readonly status: OutboxStatus;
    readonly attempts: number;
    readonly createdAt: number;
};

export type DeliveryRow = {
    readonly id: string;
    readonly event: string;
    readonly payload: string;
};

export type RouteOutcome =
    | { readonly state: "ignored"; readonly reason: string }
    | {
          readonly state: "routed";
          readonly comment: {
              readonly kind: CommentKind;
              readonly id: number;
              readonly rootId: number | null;
              readonly authorLogin: string;
          };
          /** Present when the comment starts a model turn. */
          readonly turn?: {
              readonly conversation: ConversationRow;
              readonly inbox: {
                  readonly id: string;
                  readonly messageId: string;
                  readonly prompt: string;
              };
          };
          /** Present when the comment joins a known conversation without a turn. */
          readonly conversationKey?: string;
      };

const MIGRATIONS: ReadonlyArray<string> = [
    `
    CREATE TABLE webhook_delivery (
        id TEXT PRIMARY KEY,
        event TEXT NOT NULL,
        payload TEXT,
        state TEXT NOT NULL CHECK (state IN ('received', 'routed', 'ignored')),
        reason TEXT,
        received_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE conversation (
        key TEXT PRIMARY KEY,
        installation_id INTEGER NOT NULL,
        repository_id INTEGER NOT NULL,
        repository TEXT NOT NULL,
        pull_number INTEGER NOT NULL,
        root_comment_id INTEGER,
        session_id TEXT NOT NULL UNIQUE,
        workspace_id TEXT NOT NULL UNIQUE,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE TABLE comment (
        kind TEXT NOT NULL CHECK (kind IN ('issue', 'review')),
        id INTEGER NOT NULL,
        conversation_key TEXT REFERENCES conversation(key),
        root_id INTEGER,
        author_login TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        PRIMARY KEY (kind, id)
    ) STRICT;
    CREATE TABLE inbox (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL REFERENCES conversation(key),
        message_id TEXT NOT NULL UNIQUE,
        prompt TEXT,
        status TEXT NOT NULL CHECK (status IN ('pending', 'admitted', 'complete', 'failed')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX inbox_conversation_status ON inbox(conversation_key, status);
    CREATE TABLE outbox (
        id TEXT PRIMARY KEY,
        conversation_key TEXT NOT NULL REFERENCES conversation(key),
        kind TEXT NOT NULL CHECK (kind IN ('issue', 'review')),
        body TEXT,
        status TEXT NOT NULL CHECK (status IN ('queued', 'submitting', 'submitted', 'unknown', 'failed')),
        github_comment_id INTEGER,
        attempts INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
    ) STRICT;
    CREATE INDEX outbox_conversation_status ON outbox(conversation_key, status);
    `,
    `
    ALTER TABLE conversation ADD COLUMN workspace_deleted_at INTEGER;
    `,
    `
    ALTER TABLE conversation RENAME COLUMN pull_number TO number;
    ALTER TABLE conversation ADD COLUMN target TEXT NOT NULL DEFAULT 'pull'
        CHECK (target IN ('pull', 'issue'));
    `,
];

const migrate = (db: DatabaseSync) => {
    const version = Number(
        (db.prepare("PRAGMA user_version").get() as { user_version: number })
            .user_version,
    );
    if (version > MIGRATIONS.length)
        throw new Error("database was created by a newer version");
    for (let index = version; index < MIGRATIONS.length; index++) {
        transaction(db, () => {
            db.exec(MIGRATIONS[index] as string);
            db.exec(`PRAGMA user_version = ${index + 1}`);
        });
    }
};

/** Synchronous and free of external I/O by construction. */
const transaction = <A>(db: DatabaseSync, run: () => A): A => {
    db.exec("BEGIN IMMEDIATE");
    try {
        const result = run();
        db.exec("COMMIT");
        return result;
    } catch (error) {
        db.exec("ROLLBACK");
        throw error;
    }
};

const conversationRow = (row: Record<string, SQLInputValue>) =>
    ({
        key: row.key as string,
        installationId: Number(row.installation_id),
        repositoryId: Number(row.repository_id),
        repository: row.repository as string,
        target: row.target as "pull" | "issue",
        number: Number(row.number),
        rootCommentId:
            row.root_comment_id === null ? null : Number(row.root_comment_id),
        sessionId: row.session_id as string,
        workspaceId: row.workspace_id as string,
        workspaceDeletedAt:
            row.workspace_deleted_at === null
                ? null
                : Number(row.workspace_deleted_at),
    }) satisfies ConversationRow;

const inboxRow = (row: Record<string, SQLInputValue>) =>
    ({
        id: row.id as string,
        conversationKey: row.conversation_key as string,
        messageId: row.message_id as string,
        prompt: row.prompt as string | null,
        status: row.status as InboxStatus,
    }) satisfies InboxRow;

const outboxRow = (row: Record<string, SQLInputValue>) =>
    ({
        id: row.id as string,
        conversationKey: row.conversation_key as string,
        kind: row.kind as CommentKind,
        body: row.body as string | null,
        status: row.status as OutboxStatus,
        attempts: Number(row.attempts),
        createdAt: Number(row.created_at),
    }) satisfies OutboxRow;

export const openDatabase = (path: string, now: () => number = Date.now) => {
    const db = new DatabaseSync(path);
    db.exec("PRAGMA journal_mode = WAL");
    db.exec("PRAGMA synchronous = FULL");
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA busy_timeout = 5000");
    migrate(db);

    const all = (sql: string, ...params: SQLInputValue[]) =>
        db.prepare(sql).all(...params) as Array<Record<string, SQLInputValue>>;
    const get = (sql: string, ...params: SQLInputValue[]) =>
        db.prepare(sql).get(...params) as
            | Record<string, SQLInputValue>
            | undefined;
    const run = (sql: string, ...params: SQLInputValue[]) =>
        db.prepare(sql).run(...params);

    return {
        close: () => db.close(),

        /** Returns false for a replayed delivery ID. */
        recordDelivery: (input: {
            readonly id: string;
            readonly event: string;
            readonly payload: string | null;
            readonly ignoredReason?: string;
        }) =>
            Number(
                run(
                    `INSERT INTO webhook_delivery (id, event, payload, state, reason, received_at)
                     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
                    input.id,
                    input.event,
                    input.payload,
                    input.ignoredReason === undefined ? "received" : "ignored",
                    input.ignoredReason ?? null,
                    now(),
                ).changes,
            ) === 1,

        receivedDeliveries: (): ReadonlyArray<DeliveryRow> =>
            all(
                `SELECT id, event, payload FROM webhook_delivery
                 WHERE state = 'received' ORDER BY received_at, rowid`,
            ).map((row) => ({
                id: row.id as string,
                event: row.event as string,
                payload: row.payload as string,
            })),

        /** Atomically records a delivery's routing result and any new turn. */
        routeDelivery: (deliveryId: string, outcome: RouteOutcome) =>
            transaction(db, () => {
                const at = now();
                if (outcome.state === "ignored") {
                    run(
                        `UPDATE webhook_delivery SET state = 'ignored', reason = ?, payload = NULL
                         WHERE id = ? AND state = 'received'`,
                        outcome.reason,
                        deliveryId,
                    );
                    return;
                }
                const conversationKey =
                    outcome.turn?.conversation.key ?? outcome.conversationKey;
                if (outcome.turn) {
                    const c = outcome.turn.conversation;
                    run(
                        `INSERT INTO conversation (key, installation_id, repository_id, repository,
                            target, number, root_comment_id, session_id, workspace_id, created_at, updated_at)
                         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                         ON CONFLICT (key) DO UPDATE SET repository = excluded.repository,
                            updated_at = excluded.updated_at`,
                        c.key,
                        c.installationId,
                        c.repositoryId,
                        c.repository,
                        c.target,
                        c.number,
                        c.rootCommentId,
                        c.sessionId,
                        c.workspaceId,
                        at,
                        at,
                    );
                    run(
                        `INSERT INTO inbox (id, conversation_key, message_id, prompt, status, created_at, updated_at)
                         VALUES (?, ?, ?, ?, 'pending', ?, ?) ON CONFLICT (id) DO NOTHING`,
                        outcome.turn.inbox.id,
                        c.key,
                        outcome.turn.inbox.messageId,
                        outcome.turn.inbox.prompt,
                        at,
                        at,
                    );
                }
                run(
                    `INSERT INTO comment (kind, id, conversation_key, root_id, author_login, created_at)
                     VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT (kind, id) DO NOTHING`,
                    outcome.comment.kind,
                    outcome.comment.id,
                    conversationKey ?? null,
                    outcome.comment.rootId,
                    outcome.comment.authorLogin,
                    at,
                );
                run(
                    `UPDATE webhook_delivery SET state = 'routed', payload = NULL
                     WHERE id = ? AND state = 'received'`,
                    deliveryId,
                );
            }),

        conversation: (key: string) => {
            const row = get("SELECT * FROM conversation WHERE key = ?", key);
            return row ? conversationRow(row) : undefined;
        },

        conversations: (): ReadonlyArray<ConversationRow> =>
            all("SELECT * FROM conversation ORDER BY created_at").map(
                conversationRow,
            ),

        /** Pull requests and issues that still have at least one live workspace. */
        threadsWithWorkspaces: (): ReadonlyArray<{
            readonly installationId: number;
            readonly repositoryId: number;
            readonly repository: string;
            readonly number: number;
        }> =>
            all(
                `SELECT installation_id, repository_id, MAX(repository) AS repository, number
                 FROM conversation WHERE workspace_deleted_at IS NULL
                 GROUP BY installation_id, repository_id, number`,
            ).map((row) => ({
                installationId: Number(row.installation_id),
                repositoryId: Number(row.repository_id),
                repository: row.repository as string,
                number: Number(row.number),
            })),

        liveConversationsForThread: (thread: {
            readonly installationId: number;
            readonly repositoryId: number;
            readonly number: number;
        }): ReadonlyArray<ConversationRow> =>
            all(
                `SELECT * FROM conversation WHERE installation_id = ? AND repository_id = ?
                    AND number = ? AND workspace_deleted_at IS NULL`,
                thread.installationId,
                thread.repositoryId,
                thread.number,
            ).map(conversationRow),

        setWorkspaceDeleted: (key: string, deleted: boolean) => {
            run(
                `UPDATE conversation SET workspace_deleted_at = ?, updated_at = ? WHERE key = ?`,
                deleted ? now() : null,
                now(),
                key,
            );
        },

        /**
         * Marks a deleted workspace live again for a pending turn and prefixes
         * that turn's prompt with `note`, atomically.
         */
        reviveWorkspace: (key: string, inboxId: string, note: string) =>
            transaction(db, () => {
                run(
                    `UPDATE conversation SET workspace_deleted_at = NULL, updated_at = ? WHERE key = ?`,
                    now(),
                    key,
                );
                run(
                    `UPDATE inbox SET prompt = ? || prompt, updated_at = ?
                     WHERE id = ? AND prompt IS NOT NULL`,
                    note,
                    now(),
                    inboxId,
                );
            }),

        /** Root review-comment ID for a review comment seen before. */
        reviewCommentRoot: (commentId: number) => {
            const row = get(
                "SELECT root_id FROM comment WHERE kind = 'review' AND id = ?",
                commentId,
            );
            return row?.root_id === undefined || row.root_id === null
                ? undefined
                : Number(row.root_id);
        },

        inbox: (id: string) => {
            const row = get("SELECT * FROM inbox WHERE id = ?", id);
            return row ? inboxRow(row) : undefined;
        },

        inboxItems: (conversationKey: string): ReadonlyArray<InboxRow> =>
            all(
                "SELECT * FROM inbox WHERE conversation_key = ? ORDER BY created_at, rowid",
                conversationKey,
            ).map(inboxRow),

        nextInbox: (conversationKey: string) => {
            const row = get(
                `SELECT * FROM inbox WHERE conversation_key = ? AND status IN ('pending', 'admitted')
                 ORDER BY created_at, rowid LIMIT 1`,
                conversationKey,
            );
            return row ? inboxRow(row) : undefined;
        },

        markAdmitted: (id: string) => {
            run(
                `UPDATE inbox SET status = 'admitted', updated_at = ? WHERE id = ? AND status = 'pending'`,
                now(),
                id,
            );
        },

        /** Finishes a turn and queues its reply in one transaction. */
        completeInbox: (
            id: string,
            status: "complete" | "failed",
            reply?: {
                readonly id: string;
                readonly kind: CommentKind;
                readonly body: string;
            },
        ) =>
            transaction(db, () => {
                const at = now();
                const item = get("SELECT * FROM inbox WHERE id = ?", id);
                if (!item) throw new Error("inbox item not found");
                run(
                    `UPDATE inbox SET status = ?, prompt = NULL, updated_at = ? WHERE id = ?`,
                    status,
                    at,
                    id,
                );
                if (reply)
                    run(
                        `INSERT INTO outbox (id, conversation_key, kind, body, status, created_at, updated_at)
                         VALUES (?, ?, ?, ?, 'queued', ?, ?) ON CONFLICT (id) DO NOTHING`,
                        reply.id,
                        item.conversation_key as string,
                        reply.kind,
                        reply.body,
                        at,
                        at,
                    );
            }),

        outbox: (id: string) => {
            const row = get("SELECT * FROM outbox WHERE id = ?", id);
            return row ? outboxRow(row) : undefined;
        },

        deliverableOutbox: (
            conversationKey: string,
        ): ReadonlyArray<OutboxRow> =>
            all(
                `SELECT * FROM outbox WHERE conversation_key = ? AND status IN ('queued', 'unknown')
                 ORDER BY created_at, rowid`,
                conversationKey,
            ).map(outboxRow),

        updateOutbox: (
            id: string,
            status: OutboxStatus,
            githubCommentId?: number,
        ) => {
            run(
                `UPDATE outbox SET status = ?,
                    attempts = attempts + CASE WHEN ? = 'submitting' THEN 1 ELSE 0 END,
                    github_comment_id = COALESCE(?, github_comment_id),
                    body = CASE WHEN ? = 'submitted' THEN NULL ELSE body END,
                    updated_at = ?
                 WHERE id = ?`,
                status,
                status,
                githubCommentId ?? null,
                status,
                now(),
                id,
            );
        },

        /** Conversations with durable work that a restart or lost wake must resume. */
        conversationsWithWork: (): ReadonlyArray<string> =>
            all(
                `SELECT conversation_key AS key FROM inbox WHERE status IN ('pending', 'admitted')
                 UNION
                 SELECT conversation_key AS key FROM outbox WHERE status IN ('queued', 'submitting', 'unknown')`,
            ).map((row) => row.key as string),

        /** A submission interrupted by a crash may or may not have reached GitHub. */
        markInterruptedSubmissionsUnknown: () => {
            run(
                `UPDATE outbox SET status = 'unknown', updated_at = ? WHERE status = 'submitting'`,
                now(),
            );
        },
    };
};

export type Database = ReturnType<typeof openDatabase>;

export class Repository extends Context.Service<Repository, Database>()(
    "opencode-github-bot/Repository",
) {
    static readonly layer = (path: string) =>
        Layer.effect(
            Repository,
            Effect.acquireRelease(
                Effect.try({
                    try: () => openDatabase(path),
                    catch: (cause) =>
                        new StorageError({ message: String(cause) }),
                }),
                (db) => Effect.sync(() => db.close()),
            ),
        );
}
