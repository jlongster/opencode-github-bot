import { Effect, Schema } from "effect";
import { GitHub } from "../github/client";

/**
 * Deterministic facts about one issue or pull request, gathered before any
 * model judgement. Everything here is read from GitHub or parsed from the
 * item's own text; nothing is inferred.
 */
export type ItemFacts = {
    readonly repository: string;
    readonly number: number;
    readonly kind: "issue" | "pull";
    readonly url: string;
    readonly title: string;
    /** Component prefix such as `subagent` in `subagent: tool remains…`. */
    readonly titlePrefix: string | null;
    readonly state: string;
    readonly createdAt: string;
    readonly author: {
        readonly login: string;
        readonly id: number;
        readonly type: string;
        readonly association: string;
        readonly bot: boolean;
        /** Listed in the repository's `.github/TEAM_MEMBERS`; null if there is no such file. */
        readonly teamMember: boolean | null;
        readonly priorIssues: number | null;
        readonly priorPulls: number | null;
    };
    readonly labels: ReadonlyArray<string>;
    readonly assignees: ReadonlyArray<string>;
    readonly comments: {
        readonly count: number;
        readonly commenters: ReadonlyArray<string>;
        /** Markers left by the repository's existing triage workflows. */
        readonly complianceComment: boolean;
        readonly duplicateComment: boolean;
    };
    readonly body: BodyFacts;
    readonly pull: PullFacts | null;
    readonly duplicateCandidates: ReadonlyArray<DuplicateCandidate>;
};

export type BodyFacts = {
    readonly length: number;
    readonly words: number;
    readonly headings: ReadonlyArray<string>;
    readonly template: "bug-report" | "feature-request" | null;
    /** Required template fields that are missing or left as placeholders. */
    readonly missingRequired: ReadonlyArray<string>;
    readonly environment: {
        readonly opencodeVersion: string | null;
        /** Major version line implied by `opencodeVersion`. */
        readonly versionLine: "v1" | "v2" | null;
        readonly os: string | null;
        readonly terminal: string | null;
        readonly shell: string | null;
        readonly plugins: string | null;
    };
    readonly references: {
        /** Issue or pull request numbers in the same repository. */
        readonly numbers: ReadonlyArray<number>;
        readonly commits: ReadonlyArray<string>;
        /** Repository paths linked from the text. */
        readonly codePaths: ReadonlyArray<string>;
    };
    readonly errorLines: ReadonlyArray<string>;
};

export type PullFacts = {
    readonly draft: boolean;
    readonly fromFork: boolean;
    readonly baseRef: string;
    readonly additions: number;
    readonly deletions: number;
    readonly changedFiles: number;
    readonly files: ReadonlyArray<string>;
    /** `packages/<name>` (or top-level directory) of each changed file. */
    readonly packages: ReadonlyArray<string>;
    readonly testsChanged: boolean;
    readonly docsOnly: boolean;
    /** Issues the description says it closes or fixes. */
    readonly closesIssues: ReadonlyArray<number>;
};

export type DuplicateCandidate = {
    readonly number: number;
    readonly title: string;
    readonly state: string;
    readonly labels: ReadonlyArray<string>;
    readonly matchedBy: ReadonlyArray<"title" | "error">;
};

const MAX_FILES = 300;
const MAX_ERROR_LINES = 5;
const STOPWORDS = new Set(
    "a an and are as at be but by can cannot could do does doesn for from has have how if in into is it its not of on or should so that the then this to was when where which while with without after before still when opencode open code issue bug error fails failed feature request".split(
        " ",
    ),
);

const unique = <A>(values: Iterable<A>) => [...new Set(values)];

/** `## Heading` / `### Heading` sections of a Markdown body. */
export const parseSections = (body: string) => {
    const sections = new Map<string, string>();
    let current: string | null = null;
    const lines: string[] = [];
    const flush = () => {
        if (current !== null) sections.set(current, lines.join("\n").trim());
        lines.length = 0;
    };
    for (const line of body.split(/\r?\n/)) {
        const heading = /^#{2,3}\s+(.+?)\s*#*\s*$/.exec(line);
        if (heading?.[1]) {
            flush();
            current = heading[1].trim();
        } else if (current !== null) lines.push(line);
    }
    flush();
    return sections;
};

const filled = (value: string | undefined) =>
    value !== undefined &&
    value.trim() !== "" &&
    value.trim() !== "_No response_";

const field = (
    body: string,
    sections: Map<string, string>,
    section: string,
    label: RegExp,
) => {
    const fromSection = sections.get(section);
    if (filled(fromSection)) return fromSection?.split("\n")[0]?.trim() ?? null;
    const match = label.exec(body);
    return match?.[1]?.trim().replace(/[`*]/g, "") || null;
};

/** Parses an issue or pull request body into structured, checkable facts. */
export const analyzeBody = (
    repository: string,
    title: string,
    rawBody: string | null,
): BodyFacts => {
    const body = rawBody ?? "";
    const sections = parseSections(body);
    const headings = [...sections.keys()];

    let template: BodyFacts["template"] = null;
    const missingRequired: string[] = [];
    if (
        /^\[FEATURE\]/i.test(title) ||
        sections.has("Describe the enhancement you want to request")
    ) {
        template = "feature-request";
        if (
            !filled(
                sections.get("Describe the enhancement you want to request"),
            )
        )
            missingRequired.push(
                "Describe the enhancement you want to request",
            );
        if (!/- \[x\]/i.test(body))
            missingRequired.push("Feature hasn't been suggested before");
    } else if (
        ["Description", "OpenCode version", "Steps to reproduce"].every(
            (heading) => sections.has(heading),
        )
    ) {
        template = "bug-report";
        if (!filled(sections.get("Description")))
            missingRequired.push("Description");
    }

    const opencodeVersion =
        field(
            body,
            sections,
            "OpenCode version",
            /opencode\s+version\s*[:-]?\s*v?(\d+\.\d+\.\d+[\w.-]*)/i,
        )?.match(/\d+\.\d+\.\d+[\w.-]*/)?.[0] ?? null;
    const major = opencodeVersion?.split(".")[0];

    const [owner, name] = repository.split("/");
    const sameRepo = `github\\.com/${owner}/${name}`;
    const numbers = unique(
        [
            ...[...body.matchAll(/(?:^|[\s(])#(\d{1,7})\b/g)].map((m) =>
                Number(m[1]),
            ),
            ...[
                ...body.matchAll(
                    new RegExp(`${sameRepo}/(?:issues|pull)/(\\d+)`, "gi"),
                ),
            ].map((m) => Number(m[1])),
        ].filter((value) => value > 0),
    );
    const commits = unique(
        [
            ...[...body.matchAll(/\bcommit\/([0-9a-f]{7,40})\b/gi)].map(
                (m) => m[1] as string,
            ),
            ...[
                ...body.matchAll(/(?:^|[\s`])([0-9a-f]{40})(?=[\s`]|$)/gim),
            ].map((m) => m[1] as string),
        ].map((sha) => sha.toLowerCase()),
    );
    const codePaths = unique(
        [
            ...body.matchAll(
                new RegExp(`${sameRepo}/blob/[^/\\s]+/([^\\s#)?]+)`, "gi"),
            ),
        ].map((m) => m[1] as string),
    );

    const errorLines = unique(
        body
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter((line) =>
                /\b(error|exception|failed|failure|panic|traceback|cannot|unable)\b/i.test(
                    line,
                ),
            )
            .filter((line) => !line.startsWith("#") && !line.startsWith("http"))
            .map((line) => line.slice(0, 300)),
    ).slice(0, MAX_ERROR_LINES);

    return {
        length: body.length,
        words: body.split(/\s+/).filter(Boolean).length,
        headings,
        template,
        missingRequired,
        environment: {
            opencodeVersion,
            versionLine: major === "1" ? "v1" : major === "2" ? "v2" : null,
            os: field(
                body,
                sections,
                "Operating System",
                /^\s*[-*]?\s*OS\s*[:-]\s*(.+)$/im,
            ),
            terminal: field(
                body,
                sections,
                "Terminal",
                /^\s*[-*]?\s*Terminal\s*[:-]\s*(.+)$/im,
            ),
            shell: field(
                body,
                sections,
                "Shell",
                /^\s*[-*]?\s*Shell\s*[:-]\s*(.+)$/im,
            ),
            plugins: field(
                body,
                sections,
                "Plugins",
                /^\s*[-*]?\s*(?:Active\s+)?plugins\s*[:-]\s*(.+)$/im,
            ),
        },
        references: { numbers, commits, codePaths },
        errorLines,
    };
};

/** Searchable keywords from a title, most specific words first in title order. */
export const titleKeywords = (title: string) =>
    title
        .replace(/^\[[^\]]*\]:?\s*/, "")
        .toLowerCase()
        .split(/[^a-z0-9_.-]+/)
        .map((word) => word.replace(/^[.-]+|[.-]+$/g, ""))
        .filter((word) => word.length >= 3 && !STOPWORDS.has(word))
        .slice(0, 5);

/** `subagent` in `subagent: …`, `fix(tui)` in `fix(tui): …`. */
export const titlePrefix = (title: string) =>
    /^([a-z][\w./-]*(?:\([\w./ -]+\))?(?:\s[\w./-]+)?)!?:\s/i
        .exec(title)?.[1]
        ?.toLowerCase() ?? null;

export const packageOf = (path: string) => {
    const parts = path.split("/");
    if (parts[0] === "packages" && parts[1]) return `packages/${parts[1]}`;
    return parts.length > 1 ? (parts[0] as string) : "(root)";
};

export const isTestPath = (path: string) =>
    /(^|\/)(test|tests|__tests__)\/|\.(test|spec)\.[a-z]+$/.test(path);

export const isDocsPath = (path: string) =>
    /\.(md|mdx)$/i.test(path) ||
    path.startsWith("docs/") ||
    path.includes("/content/docs/");

export const closingReferences = (body: string | null) =>
    unique(
        [
            ...(body ?? "").matchAll(
                /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)\b/gi,
            ),
        ].map((m) => Number(m[1])),
    );

const Label = Schema.Struct({ name: Schema.String });
const User = Schema.Struct({
    login: Schema.String,
    id: Schema.Int,
    type: Schema.String,
});
const IssueJson = Schema.Struct({
    number: Schema.Int,
    html_url: Schema.String,
    title: Schema.String,
    body: Schema.NullOr(Schema.String),
    state: Schema.String,
    created_at: Schema.String,
    author_association: Schema.String,
    user: User,
    labels: Schema.Array(Label),
    assignees: Schema.Array(Schema.Struct({ login: Schema.String })),
    comments: Schema.Int,
    pull_request: Schema.optional(Schema.Unknown),
});
const CommentsJson = Schema.Array(
    Schema.Struct({
        body: Schema.NullOr(Schema.String),
        user: Schema.NullOr(User),
    }),
);
const PullJson = Schema.Struct({
    draft: Schema.optional(Schema.Boolean),
    additions: Schema.Int,
    deletions: Schema.Int,
    changed_files: Schema.Int,
    base: Schema.Struct({
        ref: Schema.String,
        repo: Schema.Struct({ full_name: Schema.String }),
    }),
    head: Schema.Struct({
        repo: Schema.NullOr(Schema.Struct({ full_name: Schema.String })),
    }),
});
const FilesJson = Schema.Array(Schema.Struct({ filename: Schema.String }));
const SearchJson = Schema.Struct({
    total_count: Schema.Int,
    items: Schema.Array(
        Schema.Struct({
            number: Schema.Int,
            title: Schema.String,
            state: Schema.String,
            labels: Schema.Array(Label),
            pull_request: Schema.optional(Schema.Unknown),
        }),
    ),
});
const ContentJson = Schema.Struct({ content: Schema.String });
const RepositoryJson = Schema.Struct({ default_branch: Schema.String });

const searchPath = (query: string, perPage: number) =>
    `/search/issues?q=${encodeURIComponent(query)}&per_page=${perPage}`;

/** Collects facts for one item using only read-only, repository-restricted calls. */
export const collectFacts = Effect.fnUntraced(function* (input: {
    readonly installationId: number;
    readonly repository: string;
    readonly number: number;
}) {
    const github = yield* GitHub;
    const repo = {
        installationId: input.installationId,
        repository: input.repository,
    };
    const get = <A>(schema: Schema.Codec<A>, path: string) =>
        github
            .getJson(repo, path)
            .pipe(Effect.flatMap(Schema.decodeUnknownEffect(schema)));
    const optional = <A, E>(effect: Effect.Effect<A, E>) =>
        effect.pipe(
            Effect.map((value): A | null => value),
            Effect.catch(() => Effect.succeed(null)),
        );
    const base = `/repos/${input.repository}`;

    const issue = yield* get(IssueJson, `${base}/issues/${input.number}`);
    const kind = issue.pull_request === undefined ? "issue" : "pull";
    const login = issue.user.login;

    const [comments, teamMembers, priorIssues, priorPulls, pull] =
        yield* Effect.all(
            [
                optional(
                    get(
                        CommentsJson,
                        `${base}/issues/${input.number}/comments?per_page=100`,
                    ),
                ),
                optional(
                    Effect.gen(function* () {
                        const repository = yield* get(RepositoryJson, base);
                        const file = yield* get(
                            ContentJson,
                            `${base}/contents/.github/TEAM_MEMBERS?ref=${encodeURIComponent(repository.default_branch)}`,
                        );
                        return Buffer.from(file.content, "base64")
                            .toString("utf8")
                            .split(/\r?\n/)
                            .map((line) => line.trim().toLowerCase())
                            .filter(Boolean);
                    }),
                ),
                optional(
                    get(
                        SearchJson,
                        searchPath(
                            `repo:${input.repository} is:issue author:${login}`,
                            1,
                        ),
                    ),
                ),
                optional(
                    get(
                        SearchJson,
                        searchPath(
                            `repo:${input.repository} is:pr author:${login}`,
                            1,
                        ),
                    ),
                ),
                kind === "pull"
                    ? Effect.gen(function* () {
                          const details = yield* get(
                              PullJson,
                              `${base}/pulls/${input.number}`,
                          );
                          const files: string[] = [];
                          for (
                              let page = 1;
                              files.length < MAX_FILES && page <= 3;
                              page++
                          ) {
                              const batch = yield* get(
                                  FilesJson,
                                  `${base}/pulls/${input.number}/files?per_page=100&page=${page}`,
                              );
                              files.push(...batch.map((file) => file.filename));
                              if (batch.length < 100) break;
                          }
                          return {
                              draft: details.draft ?? false,
                              fromFork:
                                  details.head.repo?.full_name !==
                                  details.base.repo.full_name,
                              baseRef: details.base.ref,
                              additions: details.additions,
                              deletions: details.deletions,
                              changedFiles: details.changed_files,
                              files: files.slice(0, MAX_FILES),
                              packages: unique(files.map(packageOf)),
                              testsChanged: files.some(isTestPath),
                              docsOnly:
                                  files.length > 0 && files.every(isDocsPath),
                              closesIssues: closingReferences(issue.body),
                          } satisfies PullFacts;
                      })
                    : Effect.succeed(null),
            ],
            { concurrency: 4 },
        );

    const body = analyzeBody(input.repository, issue.title, issue.body);

    // Duplicate candidates: title keywords, and the first error line verbatim.
    const keywords = titleKeywords(issue.title);
    const searches: Array<[DuplicateCandidate["matchedBy"][number], string]> =
        [];
    if (keywords.length >= 2)
        searches.push([
            "title",
            `repo:${input.repository} is:issue in:title ${keywords.join(" ")}`,
        ]);
    const errorPhrase = body.errorLines[0]
        ?.replace(/["`]/g, "")
        .slice(0, 100)
        .trim();
    if (errorPhrase && errorPhrase.length >= 20)
        searches.push([
            "error",
            `repo:${input.repository} is:issue "${errorPhrase}"`,
        ]);
    const candidates = new Map<
        number,
        DuplicateCandidate & { matchedBy: Array<"title" | "error"> }
    >();
    for (const [matchedBy, query] of searches) {
        const result = yield* optional(get(SearchJson, searchPath(query, 10)));
        for (const item of result?.items ?? []) {
            if (item.number === input.number || item.pull_request !== undefined)
                continue;
            const existing = candidates.get(item.number);
            if (existing) existing.matchedBy.push(matchedBy);
            else
                candidates.set(item.number, {
                    number: item.number,
                    title: item.title,
                    state: item.state,
                    labels: item.labels.map((label) => label.name),
                    matchedBy: [matchedBy],
                });
        }
    }

    const commentList = comments ?? [];
    return {
        repository: input.repository,
        number: issue.number,
        kind,
        url: issue.html_url,
        title: issue.title,
        titlePrefix: titlePrefix(issue.title),
        state: issue.state,
        createdAt: issue.created_at,
        author: {
            login,
            id: issue.user.id,
            type: issue.user.type,
            association: issue.author_association,
            bot: issue.user.type === "Bot" || login.endsWith("[bot]"),
            teamMember: teamMembers
                ? teamMembers.includes(login.toLowerCase())
                : null,
            priorIssues: priorIssues
                ? Math.max(
                      0,
                      priorIssues.total_count - (kind === "issue" ? 1 : 0),
                  )
                : null,
            priorPulls: priorPulls
                ? Math.max(
                      0,
                      priorPulls.total_count - (kind === "pull" ? 1 : 0),
                  )
                : null,
        },
        labels: issue.labels.map((label) => label.name),
        assignees: issue.assignees.map((assignee) => assignee.login),
        comments: {
            count: issue.comments,
            commenters: unique(
                commentList.flatMap((comment) =>
                    comment.user ? [comment.user.login] : [],
                ),
            ),
            complianceComment: commentList.some((comment) =>
                comment.body?.includes("<!-- issue-compliance -->"),
            ),
            duplicateComment: commentList.some((comment) =>
                /might be a duplicate|possible duplicate/i.test(
                    comment.body ?? "",
                ),
            ),
        },
        body,
        pull,
        duplicateCandidates: [...candidates.values()],
    } satisfies ItemFacts;
});
