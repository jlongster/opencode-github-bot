import { createHash } from "node:crypto";
import type { CommentEvent } from "./events";

export const REPLY_MARKER_PREFIX = "<!-- opencode-github-bot:reply:";

export const replyMarker = (replyId: string) =>
    `${REPLY_MARKER_PREFIX}${replyId} -->`;

type Thread = Pick<
    CommentEvent,
    "installationId" | "repositoryId" | "target" | "number"
>;

const threadPrefix = (event: Thread) =>
    `github:${event.installationId}:${event.repositoryId}:${event.target}:${event.number}`;

/**
 * All top-level comments on one pull request or issue share this
 * conversation, e.g. `github:1:2:pull:7:conversation` or
 * `github:1:2:issue:9:conversation`.
 */
export const topLevelConversationKey = (event: Thread) =>
    `${threadPrefix(event)}:conversation`;

/** Each inline review thread is keyed by its root review-comment ID. */
export const reviewConversationKey = (
    event: Omit<Thread, "target">,
    rootCommentId: number,
) => `${threadPrefix({ ...event, target: "pull" })}:review:${rootCommentId}`;

/** Opaque, filesystem- and username-safe identifier for a conversation. */
export const workspaceId = (conversationKey: string) =>
    createHash("sha256").update(conversationKey).digest("hex").slice(0, 20);

export const mentions = (body: string, appSlug: string) =>
    new RegExp(
        `(^|[^A-Za-z0-9_-])@${appSlug.replace(/[-]/g, "\\-")}(?![A-Za-z0-9_-])`,
        "i",
    ).test(body);

export type BotIdentity = {
    readonly appSlug: string;
    readonly allowedInstallations: ReadonlyArray<number>;
    /** GitHub user IDs allowed to trigger the bot; everyone else is ignored. */
    readonly allowedUsers: ReadonlyArray<number>;
};

/** Comments the bot must never answer, regardless of thread. */
export const ignoredReason = (
    event: CommentEvent,
    bot: BotIdentity,
): string | undefined => {
    if (!bot.allowedInstallations.includes(event.installationId))
        return "installation-not-allowed";
    if (event.action !== "created") return `comment-${event.action}`;
    if (!event.open) return "closed";
    if (
        event.author.bot ||
        event.author.login.toLowerCase() === `${bot.appSlug}[bot]` ||
        event.body.includes(REPLY_MARKER_PREFIX)
    )
        return "bot-author";
    if (!bot.allowedUsers.includes(event.author.id)) return "user-not-allowed";
    return undefined;
};
