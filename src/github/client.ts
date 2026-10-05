import { Context, Effect, Layer, Schema } from "effect";
import { appJwt } from "./auth";

export class GitHubError extends Schema.TaggedError<GitHubError>()(
    "GitHubError",
    {
        /** HTTP status, or null when no response was received. */
        status: Schema.NullOr(Schema.Int),
        operation: Schema.String,
    },
) {
    /** True when a write may have reached GitHub despite the error. */
    get ambiguous() {
        return this.status === null || this.status >= 500;
    }
}

export type GitHubOptions = {
    readonly apiUrl: string;
    readonly appId: number;
    readonly privateKey: string;
    readonly now?: () => number;
};

type Repo = { readonly installationId: number; readonly repository: string };

/** Everything the bot does; the App itself may be granted far more. */
export const TOKEN_PERMISSIONS: Readonly<Record<string, string>> = {
    issues: "write",
    pull_requests: "write",
    contents: "read",
    metadata: "read",
};

const MAX_LIST_PAGES = 10;
const MAX_PARENT_DEPTH = 10;

export const makeGitHub = (options: GitHubOptions) => {
    const now = options.now ?? Date.now;
    const tokens = new Map<string, { token: string; expiresAt: number }>();

    const request = (
        operation: string,
        method: "GET" | "POST",
        path: string,
        authorization: string,
        body?: unknown,
    ) =>
        Effect.tryPromise({
            try: (signal) =>
                fetch(new URL(path, options.apiUrl), {
                    method,
                    headers: {
                        accept: "application/vnd.github+json",
                        authorization,
                        "user-agent": "opencode-github-bot",
                        "x-github-api-version": "2022-11-28",
                        ...(body === undefined
                            ? {}
                            : { "content-type": "application/json" }),
                    },
                    ...(body === undefined
                        ? {}
                        : { body: JSON.stringify(body) }),
                    signal: AbortSignal.any([
                        signal,
                        AbortSignal.timeout(30_000),
                    ]),
                }),
            catch: () => new GitHubError({ status: null, operation }),
        }).pipe(
            Effect.flatMap((response) =>
                response.ok
                    ? Effect.tryPromise({
                          try: () => response.json() as Promise<unknown>,
                          catch: () =>
                              new GitHubError({ status: null, operation }),
                      })
                    : Effect.fail(
                          new GitHubError({
                              status: response.status,
                              operation,
                          }),
                      ),
            ),
        );

    /**
     * Installation tokens are limited to one repository and the minimum
     * permissions, whatever the App's installation allows. A response granting
     * anything else is rejected rather than used.
     */
    const installationToken = (repo: Repo) =>
        Effect.gen(function* () {
            const name = repo.repository.split("/")[1] ?? "";
            const key = `${repo.installationId}:${repo.repository.toLowerCase()}`;
            const cached = tokens.get(key);
            if (cached && cached.expiresAt - now() > 5 * 60_000)
                return cached.token;
            const failure = () =>
                new GitHubError({
                    status: null,
                    operation: "installation-token",
                });
            const value = yield* request(
                "installation-token",
                "POST",
                `/app/installations/${repo.installationId}/access_tokens`,
                `Bearer ${appJwt(options.appId, options.privateKey, now())}`,
                { repositories: [name], permissions: TOKEN_PERMISSIONS },
            );
            const decoded = yield* Schema.decodeUnknownEffect(
                Schema.Struct({
                    token: Schema.String,
                    expires_at: Schema.String,
                    permissions: Schema.Record(Schema.String, Schema.String),
                    repositories: Schema.Array(
                        Schema.Struct({ full_name: Schema.String }),
                    ),
                }),
            )(value).pipe(Effect.mapError(failure));
            const granted = Object.entries(decoded.permissions);
            if (
                granted.length !== Object.keys(TOKEN_PERMISSIONS).length ||
                granted.some(
                    ([permission, level]) =>
                        TOKEN_PERMISSIONS[permission] !== level,
                ) ||
                decoded.repositories.length !== 1 ||
                decoded.repositories[0]?.full_name.toLowerCase() !==
                    repo.repository.toLowerCase()
            )
                return yield* Effect.fail(failure());
            tokens.set(key, {
                token: decoded.token,
                expiresAt: Date.parse(decoded.expires_at),
            });
            return decoded.token;
        });

    const api = (
        repo: Repo,
        operation: string,
        method: "GET" | "POST",
        path: string,
        body?: unknown,
    ) => {
        const attempt = installationToken(repo).pipe(
            Effect.flatMap((token) =>
                request(operation, method, path, `Bearer ${token}`, body),
            ),
        );
        // A cached token GitHub rejects early (e.g. after suspension) is
        // dropped and replaced once.
        return attempt.pipe(
            Effect.catchIf(
                (error) => error.status === 401,
                () =>
                    Effect.sync(() =>
                        tokens.delete(
                            `${repo.installationId}:${repo.repository.toLowerCase()}`,
                        ),
                    ).pipe(Effect.andThen(attempt)),
            ),
        );
    };

    const decodeId = (operation: string) => (value: unknown) =>
        Schema.decodeUnknownEffect(Schema.Struct({ id: Schema.Int }))(
            value,
        ).pipe(
            Effect.map((comment) => comment.id),
            Effect.mapError(() => new GitHubError({ status: null, operation })),
        );

    const CommentList = Schema.Array(
        Schema.Struct({
            id: Schema.Int,
            body: Schema.optional(Schema.NullOr(Schema.String)),
        }),
    );

    return {
        installationToken,

        /** The App's installation for a repository (App JWT; no installation token). */
        repositoryInstallation: (repository: string) =>
            request(
                "repository-installation",
                "GET",
                `/repos/${repository}/installation`,
                `Bearer ${appJwt(options.appId, options.privateKey, now())}`,
            ).pipe(
                Effect.flatMap(
                    Schema.decodeUnknownEffect(
                        Schema.Struct({ id: Schema.Int }),
                    ),
                ),
                Effect.map((installation) => installation.id),
                Effect.mapError((error) =>
                    error instanceof GitHubError
                        ? error
                        : new GitHubError({
                              status: null,
                              operation: "repository-installation",
                          }),
                ),
            ),

        /** Read-only GET with a repository-restricted token, for fact collection. */
        getJson: (repo: Repo, path: string) => api(repo, "get", "GET", path),

        /** Follows `in_reply_to_id` from a review comment to its thread root. */
        reviewThreadRoot: (repo: Repo, commentId: number) =>
            Effect.gen(function* () {
                let current = commentId;
                for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
                    const value = yield* api(
                        repo,
                        "review-comment",
                        "GET",
                        `/repos/${repo.repository}/pulls/comments/${current}`,
                    );
                    const parent = (value as { in_reply_to_id?: unknown })
                        .in_reply_to_id;
                    if (typeof parent !== "number") return current;
                    current = parent;
                }
                return yield* new GitHubError({
                    status: null,
                    operation: "review-comment-depth",
                });
            }),

        pullRequest: (repo: Repo, pullNumber: number) =>
            api(
                repo,
                "pull-request",
                "GET",
                `/repos/${repo.repository}/pulls/${pullNumber}`,
            ).pipe(
                Effect.flatMap(
                    Schema.decodeUnknownEffect(
                        Schema.Struct({
                            state: Schema.String,
                            closed_at: Schema.optional(
                                Schema.NullOr(Schema.String),
                            ),
                            base: Schema.Struct({ ref: Schema.String }),
                            head: Schema.Struct({ sha: Schema.String }),
                        }),
                    ),
                ),
                Effect.map((pull) => ({
                    baseRef: pull.base.ref,
                    headSha: pull.head.sha,
                    open: pull.state === "open",
                    closedAt: pull.closed_at
                        ? Date.parse(pull.closed_at)
                        : null,
                })),
                Effect.mapError((error) =>
                    error instanceof GitHubError
                        ? error
                        : new GitHubError({
                              status: null,
                              operation: "pull-request",
                          }),
                ),
            ),

        /** Open/closed state of an issue or pull request (both are issues). */
        issueState: (repo: Repo, number: number) =>
            api(
                repo,
                "issue",
                "GET",
                `/repos/${repo.repository}/issues/${number}`,
            ).pipe(
                Effect.flatMap(
                    Schema.decodeUnknownEffect(
                        Schema.Struct({
                            state: Schema.String,
                            closed_at: Schema.optional(
                                Schema.NullOr(Schema.String),
                            ),
                        }),
                    ),
                ),
                Effect.map((issue) => ({
                    open: issue.state === "open",
                    closedAt: issue.closed_at
                        ? Date.parse(issue.closed_at)
                        : null,
                })),
                Effect.mapError((error) =>
                    error instanceof GitHubError
                        ? error
                        : new GitHubError({ status: null, operation: "issue" }),
                ),
            ),

        defaultBranch: (repo: Repo) =>
            api(repo, "repository", "GET", `/repos/${repo.repository}`).pipe(
                Effect.flatMap(
                    Schema.decodeUnknownEffect(
                        Schema.Struct({ default_branch: Schema.String }),
                    ),
                ),
                Effect.map((value) => value.default_branch),
                Effect.mapError((error) =>
                    error instanceof GitHubError
                        ? error
                        : new GitHubError({
                              status: null,
                              operation: "repository",
                          }),
                ),
            ),

        createIssueComment: (repo: Repo, number: number, body: string) =>
            api(
                repo,
                "create-issue-comment",
                "POST",
                `/repos/${repo.repository}/issues/${number}/comments`,
                { body },
            ).pipe(Effect.flatMap(decodeId("create-issue-comment"))),

        createReviewReply: (
            repo: Repo,
            pullNumber: number,
            rootCommentId: number,
            body: string,
        ) =>
            api(
                repo,
                "create-review-reply",
                "POST",
                `/repos/${repo.repository}/pulls/${pullNumber}/comments/${rootCommentId}/replies`,
                { body },
            ).pipe(Effect.flatMap(decodeId("create-review-reply"))),

        /**
         * Searches a bounded window of destination comments for an exact marker.
         * Returns null when absence is established within the window.
         */
        findMarkedComment: (
            repo: Repo,
            kind: "issue" | "review",
            number: number,
            marker: string,
            since: number,
        ) =>
            Effect.gen(function* () {
                const base =
                    kind === "issue"
                        ? `/repos/${repo.repository}/issues/${number}/comments`
                        : `/repos/${repo.repository}/pulls/${number}/comments`;
                const sinceParam = new Date(since - 60_000).toISOString();
                for (let page = 1; page <= MAX_LIST_PAGES; page++) {
                    const value = yield* api(
                        repo,
                        "list-comments",
                        "GET",
                        `${base}?since=${encodeURIComponent(sinceParam)}&per_page=100&page=${page}`,
                    );
                    const comments = yield* Schema.decodeUnknownEffect(
                        CommentList,
                    )(value).pipe(
                        Effect.mapError(
                            () =>
                                new GitHubError({
                                    status: null,
                                    operation: "list-comments",
                                }),
                        ),
                    );
                    const found = comments.find((comment) =>
                        comment.body?.includes(marker),
                    );
                    if (found) return found.id;
                    if (comments.length < 100) return null;
                }
                return yield* new GitHubError({
                    status: null,
                    operation: "list-comments-bound",
                });
            }),
    };
};

export class GitHub extends Context.Service<
    GitHub,
    ReturnType<typeof makeGitHub>
>()("opencode-github-bot/GitHub") {
    static readonly layer = (options: GitHubOptions) =>
        Layer.sync(GitHub, () => makeGitHub(options));
}
