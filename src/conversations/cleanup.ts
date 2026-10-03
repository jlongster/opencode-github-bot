import { Effect } from "effect";
import { GitHub } from "../github/client";
import { Repository } from "./repository";

export const CLOSED_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;

export type CleanupOptions = {
    /** How long a pull request or issue must have been closed. */
    readonly closedForMs: number;
    readonly now?: () => number;
    /** Queues deletion of a workspace's Linux user and directory. */
    readonly requestDeletion: (
        workspaceId: string,
    ) => Effect.Effect<void, unknown>;
};

/**
 * Deletes the workspaces of every conversation whose pull request or issue has
 * been closed for longer than `closedForMs`, using GitHub's current state so
 * reopened ones are kept. Conversation records and OpenCode sessions
 * are retained. A deletion is requested before it is recorded, so a crash can
 * at worst repeat an idempotent request.
 */
export const cleanupClosedWorkspaces = Effect.fnUntraced(function* (
    options: CleanupOptions,
) {
    const repository = yield* Repository;
    const github = yield* GitHub;
    const now = options.now ?? Date.now;
    const deleted: string[] = [];
    for (const thread of repository.threadsWithWorkspaces()) {
        const state = yield* github.issueState(thread, thread.number).pipe(
            Effect.tapError((error) =>
                Effect.logWarning("cleanup skipped thread", {
                    repository: thread.repositoryId,
                    number: thread.number,
                    httpStatus: error.status,
                }),
            ),
            Effect.option,
        );
        if (state._tag === "None") continue;
        const { open, closedAt } = state.value;
        if (open || closedAt === null || now() - closedAt < options.closedForMs)
            continue;
        for (const conversation of repository.liveConversationsForThread(
            thread,
        )) {
            yield* options.requestDeletion(conversation.workspaceId);
            repository.setWorkspaceDeleted(conversation.key, true);
            deleted.push(conversation.key);
        }
    }
    return deleted;
});
