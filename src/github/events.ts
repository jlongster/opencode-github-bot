import { Option, Schema } from "effect";

const Id = Schema.Int.check(Schema.isGreaterThan(0));

const User = Schema.Struct({
    id: Id,
    login: Schema.String,
    type: Schema.String,
});

const Repository = Schema.Struct({ id: Id, full_name: Schema.String });
const Installation = Schema.Struct({ id: Id });
const Action = Schema.Literals(["created", "edited", "deleted"]);

const IssueCommentPayload = Schema.Struct({
    action: Action,
    issue: Schema.Struct({
        number: Id,
        state: Schema.String,
        pull_request: Schema.optional(Schema.Unknown),
    }),
    comment: Schema.Struct({
        id: Id,
        body: Schema.NullOr(Schema.String),
        user: User,
    }),
    repository: Repository,
    installation: Installation,
});

const ReviewCommentPayload = Schema.Struct({
    action: Action,
    pull_request: Schema.Struct({ number: Id, state: Schema.String }),
    comment: Schema.Struct({
        id: Id,
        body: Schema.NullOr(Schema.String),
        user: User,
        in_reply_to_id: Schema.optional(Id),
        path: Schema.String,
        line: Schema.optional(Schema.NullOr(Schema.Int)),
        diff_hunk: Schema.optional(Schema.String),
    }),
    repository: Repository,
    installation: Installation,
});

/**
 * A comment normalized from either webhook event type. `kind` is the GitHub
 * comment API it belongs to (`issue` comments include top-level pull-request
 * comments); `target` is what was commented on.
 */
export const CommentEvent = Schema.Struct({
    kind: Schema.Literals(["issue", "review"]),
    target: Schema.Literals(["pull", "issue"]),
    action: Action,
    installationId: Id,
    repositoryId: Id,
    repository: Schema.String,
    /** Pull-request or issue number. */
    number: Id,
    /** Whether the pull request or issue was open when the comment was made. */
    open: Schema.Boolean,
    commentId: Id,
    inReplyToId: Schema.NullOr(Id),
    author: Schema.Struct({
        id: Id,
        login: Schema.String,
        bot: Schema.Boolean,
    }),
    body: Schema.String,
    path: Schema.NullOr(Schema.String),
    line: Schema.NullOr(Schema.Int),
    diffHunk: Schema.NullOr(Schema.String),
});
export type CommentEvent = typeof CommentEvent.Type;

const isBot = (user: typeof User.Type) => user.type === "Bot";

/** Normalizes supported comment webhooks; returns `None` for anything else. */
export const decodeCommentEvent = (
    event: string,
    payload: unknown,
): Option.Option<CommentEvent> => {
    if (event === "issue_comment") {
        const decoded =
            Schema.decodeUnknownOption(IssueCommentPayload)(payload);
        if (Option.isNone(decoded)) return Option.none();
        const value = decoded.value;
        return Option.some({
            kind: "issue",
            target: value.issue.pull_request === undefined ? "issue" : "pull",
            action: value.action,
            installationId: value.installation.id,
            repositoryId: value.repository.id,
            repository: value.repository.full_name,
            number: value.issue.number,
            open: value.issue.state === "open",
            commentId: value.comment.id,
            inReplyToId: null,
            author: {
                id: value.comment.user.id,
                login: value.comment.user.login,
                bot: isBot(value.comment.user),
            },
            body: value.comment.body ?? "",
            path: null,
            line: null,
            diffHunk: null,
        });
    }
    if (event === "pull_request_review_comment") {
        const decoded =
            Schema.decodeUnknownOption(ReviewCommentPayload)(payload);
        if (Option.isNone(decoded)) return Option.none();
        const value = decoded.value;
        return Option.some({
            kind: "review",
            target: "pull",
            action: value.action,
            installationId: value.installation.id,
            repositoryId: value.repository.id,
            repository: value.repository.full_name,
            number: value.pull_request.number,
            open: value.pull_request.state === "open",
            commentId: value.comment.id,
            inReplyToId: value.comment.in_reply_to_id ?? null,
            author: {
                id: value.comment.user.id,
                login: value.comment.user.login,
                bot: isBot(value.comment.user),
            },
            body: value.comment.body ?? "",
            path: value.comment.path,
            line: value.comment.line ?? null,
            diffHunk: value.comment.diff_hunk ?? null,
        });
    }
    return Option.none();
};
