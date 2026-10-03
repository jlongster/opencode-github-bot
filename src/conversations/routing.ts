import { createHash } from "node:crypto";
import { Session } from "@opencode/sdk/effect";
import { Effect } from "effect";
import { GitHub } from "../github/client";
import type { CommentEvent } from "../github/events";
import {
    type BotIdentity,
    ignoredReason,
    mentions,
    reviewConversationKey,
    topLevelConversationKey,
    workspaceId,
} from "../github/threads";
import {
    type ConversationRow,
    Repository,
    type RouteOutcome,
} from "./repository";

const MAX_PROMPT_BODY = 12_000;

export const inboxId = (event: Pick<CommentEvent, "kind" | "commentId">) =>
    `${event.kind}-comment:${event.commentId}`;

/** Stable OpenCode message ID: retried admission of one comment is deduplicated. */
export const stableMessageId = (inboxItemId: string) =>
    `msg_${createHash("sha256").update(inboxItemId).digest("hex")}`;

export const formatPrompt = (event: CommentEvent) => {
    const lines =
        event.target === "pull"
            ? [
                  `GitHub pull request comment from @${event.author.login} on ${event.repository}#${event.number}.`,
                  `The pull request is checked out in \`repo/\` on branch \`pr-${event.number}\`; refs \`pr/head\` and \`pr/base\` are refreshed from GitHub before each turn.`,
              ]
            : [
                  `GitHub issue comment from @${event.author.login} on ${event.repository}#${event.number}.`,
                  `The repository's default branch is checked out in \`repo/\` on branch \`issue-${event.number}\`; ref \`default\` is refreshed from GitHub before each turn.`,
              ];
    if (event.kind === "review") {
        lines.push(
            `This is an inline review comment on \`${event.path}\`${event.line === null ? "" : ` line ${event.line}`}.`,
        );
        if (event.diffHunk)
            lines.push("", "```diff", event.diffHunk.slice(-4_000), "```");
    }
    lines.push("", event.body.slice(0, MAX_PROMPT_BODY));
    return lines.join("\n");
};

/**
 * Decides which conversation a comment belongs to and whether it starts a
 * turn. Inline replies resolve their thread root locally first and fall back
 * to a bounded GitHub parent-chain lookup.
 */
export const routeEvent = Effect.fnUntraced(function* (
    event: CommentEvent,
    bot: BotIdentity,
) {
    const repository = yield* Repository;
    const ignored = ignoredReason(event, bot);
    if (ignored) return { state: "ignored", reason: ignored } as RouteOutcome;

    let rootId: number | null = null;
    let key: string;
    if (event.kind === "issue") {
        key = topLevelConversationKey(event);
    } else {
        if (event.inReplyToId === null) rootId = event.commentId;
        else {
            const parentId = event.inReplyToId;
            rootId =
                repository.reviewCommentRoot(parentId) ??
                (yield* (yield* GitHub).reviewThreadRoot(event, parentId));
        }
        key = reviewConversationKey(event, rootId);
    }

    const existing = repository.conversation(key);
    const comment = {
        kind: event.kind,
        id: event.commentId,
        rootId,
        authorLogin: event.author.login,
    };
    const triggered =
        mentions(event.body, bot.appSlug) ||
        (event.kind === "review" && existing !== undefined);
    if (!triggered) {
        return {
            state: "routed",
            comment,
            ...(existing ? { conversationKey: key } : {}),
        } as RouteOutcome;
    }

    const conversation: ConversationRow = existing
        ? { ...existing, repository: event.repository }
        : {
              key,
              installationId: event.installationId,
              repositoryId: event.repositoryId,
              repository: event.repository,
              target: event.target,
              number: event.number,
              rootCommentId: rootId,
              sessionId: Session.ID.create(),
              workspaceId: workspaceId(key),
              workspaceDeletedAt: null,
          };
    const id = inboxId(event);
    return {
        state: "routed",
        comment,
        turn: {
            conversation,
            inbox: {
                id,
                messageId: stableMessageId(id),
                prompt: formatPrompt(event),
            },
        },
    } as RouteOutcome;
});
