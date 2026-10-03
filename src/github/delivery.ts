import { Effect } from "effect";
import {
    type ConversationRow,
    type OutboxRow,
    Repository,
} from "../conversations/repository";
import { GitHub, type GitHubError } from "./client";
import { replyMarker } from "./threads";

const MAX_BODY = 60_000;
const MAX_ATTEMPTS = 5;

export const replyBody = (replyId: string, text: string) => {
    const body =
        text.length > MAX_BODY
            ? `${text.slice(0, MAX_BODY)}\n\n…(truncated)`
            : text;
    return `${body}\n\n${replyMarker(replyId)}`;
};

/**
 * Submits one queued reply, or reconciles an ambiguous one. A reply is only
 * resubmitted after its marker is proven absent from the destination.
 */
export const deliverReply = Effect.fnUntraced(function* (
    reply: OutboxRow,
    conversation: ConversationRow,
) {
    const repository = yield* Repository;
    const github = yield* GitHub;

    if (reply.status === "unknown") {
        const found = yield* github
            .findMarkedComment(
                conversation,
                reply.kind,
                conversation.number,
                replyMarker(reply.id),
                reply.createdAt,
            )
            .pipe(Effect.option);
        if (found._tag === "None") return "unknown" as const;
        if (found.value !== null) {
            repository.updateOutbox(reply.id, "submitted", found.value);
            return "submitted" as const;
        }
    }
    if (reply.body === null || reply.attempts >= MAX_ATTEMPTS) {
        repository.updateOutbox(reply.id, "failed");
        return "failed" as const;
    }

    repository.updateOutbox(reply.id, "submitting");
    const submit =
        reply.kind === "issue"
            ? github.createIssueComment(
                  conversation,
                  conversation.number,
                  reply.body,
              )
            : github.createReviewReply(
                  conversation,
                  conversation.number,
                  conversation.rootCommentId ?? 0,
                  reply.body,
              );
    return yield* submit.pipe(
        Effect.map((commentId) => {
            repository.updateOutbox(reply.id, "submitted", commentId);
            return "submitted" as const;
        }),
        Effect.catch((error: GitHubError) => {
            const status = error.ambiguous
                ? "unknown"
                : error.status === 429
                  ? "queued"
                  : "failed";
            repository.updateOutbox(reply.id, status);
            return Effect.logWarning("reply not confirmed", {
                reply: reply.id,
                operation: error.operation,
                httpStatus: error.status,
                outcome: status,
            }).pipe(Effect.as(status));
        }),
    );
});
