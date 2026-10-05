import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { GitHub, TOKEN_PERMISSIONS } from "../src/github/client";
import {
    analyzeBody,
    closingReferences,
    collectFacts,
    duplicateTitleQueries,
    extractErrorLines,
    isDocsPath,
    isTestPath,
    packageOf,
    titleKeywords,
    titlePrefix,
} from "../src/triage/facts";
import { fakeGitHub, privateKey } from "./support";

const REPO = "acme/widgets";

const freeFormBug = [
    "## Summary",
    "",
    "Child sessions still see the `delegate` tool at the depth limit. Workers prepare calls that cannot succeed, and this failed before.",
    "",
    "## Environment",
    "",
    "- opencode version: 2.0.23",
    "- OS: Darwin 25.6.0 arm64",
    "- Terminal: ghostty",
    "- Shell: /bin/zsh",
    "- Active plugins: example-plugin@0.2.0",
    "",
    "## Actual Behavior",
    "",
    "```text",
    "Delegate depth limit reached (1). Increase the limit to allow nesting.",
    "Error: delegation failed for worker",
    "```",
    "",
    "## Additional Context",
    "",
    "- Checkout `759175abad82df23a83e85a089aa3c6df4f83b23`, see [code](https://github.com/acme/widgets/blob/759175abad82df23a83e85a089aa3c6df4f83b23/packages/core/src/tool/delegate.ts#L117-L133).",
    "- Related: #37235 and https://github.com/acme/widgets/issues/48106; unrelated https://github.com/other/repo/issues/5.",
].join("\n");

const bugTemplate = (description: string) =>
    [
        "### Description",
        "",
        description,
        "",
        "### Plugins",
        "",
        "_No response_",
        "",
        "### OpenCode version",
        "",
        "1.14.2",
        "",
        "### Steps to reproduce",
        "",
        "_No response_",
        "",
        "### Operating System",
        "",
        "Windows 11",
        "",
        "### Terminal",
        "",
        "Windows Terminal",
    ].join("\n");

describe("body analysis", () => {
    it("extracts environment, references and errors from a free-form report", () => {
        const facts = analyzeBody(
            REPO,
            "delegate: tool remains advertised",
            freeFormBug,
        );
        expect(facts.template).toBeNull();
        expect(facts.missingRequired).toEqual([]);
        expect(facts.headings).toEqual([
            "Summary",
            "Environment",
            "Actual Behavior",
            "Additional Context",
        ]);
        expect(facts.environment).toEqual({
            opencodeVersion: "2.0.23",
            versionLine: "v2",
            os: "Darwin 25.6.0 arm64",
            terminal: "ghostty",
            shell: "/bin/zsh",
            plugins: "example-plugin@0.2.0",
        });
        expect(facts.references.numbers).toEqual([37235, 48106]);
        expect(facts.references.commits).toEqual([
            "759175abad82df23a83e85a089aa3c6df4f83b23",
        ]);
        expect(facts.references.codePaths).toEqual([
            "packages/core/src/tool/delegate.ts",
        ]);
        // Quoted output only; prose that merely mentions failure is ignored.
        expect(facts.errorLines).toEqual([
            "Delegate depth limit reached (1). Increase the limit to allow nesting.",
            "Error: delegation failed for worker",
        ]);
    });

    it("recognizes the bug report template and placeholder required fields", () => {
        const filled = analyzeBody(
            REPO,
            "crash on start",
            bugTemplate("It crashes when I start it."),
        );
        expect(filled.template).toBe("bug-report");
        expect(filled.missingRequired).toEqual([]);
        expect(filled.environment).toMatchObject({
            opencodeVersion: "1.14.2",
            versionLine: "v1",
            os: "Windows 11",
            terminal: "Windows Terminal",
            plugins: null,
        });
        expect(
            analyzeBody(REPO, "crash", bugTemplate("_No response_"))
                .missingRequired,
        ).toEqual(["Description"]);
    });

    it("recognizes feature requests and their required checkbox", () => {
        const body =
            "### Feature hasn't been suggested before.\n\n- [ ] I have verified\n\n### Describe the enhancement you want to request\n\nDark mode.";
        const facts = analyzeBody(REPO, "[FEATURE]: dark mode", body);
        expect(facts.template).toBe("feature-request");
        expect(facts.missingRequired).toEqual([
            "Feature hasn't been suggested before",
        ]);
    });

    it("derives keywords, packages and test or docs paths", () => {
        expect(
            titleKeywords(
                "delegate: tool remains advertised at the maximum session depth",
            ),
        ).toEqual([
            "delegate",
            "tool",
            "remains",
            "advertised",
            "maximum",
            "session",
        ]);
        expect(
            duplicateTitleQueries(
                "delegate: tool remains at the maximum depth",
            ),
        ).toEqual([
            "delegate tool",
            "delegate remains",
            "delegate maximum",
            "delegate depth",
        ]);
        expect(titleKeywords("[FEATURE]: Add dark mode to TUI")).toEqual([
            "add",
            "dark",
            "mode",
            "tui",
        ]);
        expect(titlePrefix("subagent: tool remains advertised")).toBe(
            "subagent",
        );
        expect(titlePrefix("fix(tui)!: keep scroll position")).toBe("fix(tui)");
        expect(titlePrefix("Crash when starting: details")).toBeNull();
        expect(titlePrefix("No prefix here")).toBeNull();
        expect(packageOf("packages/tui/src/app.tsx")).toBe("packages/tui");
        expect(packageOf(".github/workflows/ci.yml")).toBe(".github");
        expect(packageOf("README.md")).toBe("(root)");
        expect(isTestPath("packages/core/test/session.test.ts")).toBe(true);
        expect(isTestPath("packages/core/src/session.ts")).toBe(false);
        expect(isDocsPath("packages/web/src/content/docs/github.mdx")).toBe(
            true,
        );
        expect(
            closingReferences("Fixes #12, closes #34 and mentions #56"),
        ).toEqual([12, 34]);
        expect(
            extractErrorLines(
                "It cannot start.\nTypeError: x is undefined\n```ts\nconst a = 1;\n```",
            ),
        ).toEqual(["TypeError: x is undefined"]);
    });
});

describe("fact collection", () => {
    const issueJson = (overrides: Record<string, unknown>) => ({
        number: 9,
        html_url: `https://github.com/${REPO}/issues/9`,
        title: "delegate: tool remains advertised at the maximum session depth",
        body: freeFormBug,
        state: "open",
        created_at: "2026-10-05T13:23:44Z",
        author_association: "NONE",
        user: { login: "reporter", id: 501, type: "User" },
        labels: [{ name: "needs:compliance" }],
        assignees: [{ login: "maintainer" }],
        comments: 1,
        ...overrides,
    });

    const run = (
        github: Awaited<ReturnType<typeof fakeGitHub>>,
        number: number,
    ) =>
        Effect.runPromise(
            collectFacts({ installationId: 11, repository: REPO, number }).pipe(
                Effect.provide(
                    GitHub.layer({ apiUrl: github.url, appId: 1, privateKey }),
                ),
            ),
        );

    it("collects issue facts with read-only, repository-restricted calls", async () => {
        const github = await fakeGitHub();
        try {
            const searches: string[] = [];
            github.routes.set(`/repos/${REPO}/issues/9`, () => issueJson({}));
            github.routes.set(`/repos/${REPO}/issues/9/comments`, () => [
                {
                    body: "<!-- issue-compliance -->\nPlease use a template.",
                    user: { login: "github-actions[bot]", id: 1, type: "Bot" },
                },
            ]);
            github.routes.set(
                `/repos/${REPO}/contents/.github/TEAM_MEMBERS`,
                () => ({
                    content: Buffer.from("maintainer\nReporter2\n").toString(
                        "base64",
                    ),
                }),
            );
            github.routes.set("/search/issues", (url) => {
                const query = url.searchParams.get("q") ?? "";
                searches.push(query);
                if (query.includes("author:"))
                    return {
                        total_count: query.includes("is:issue") ? 4 : 0,
                        items: [],
                    };
                return {
                    total_count: 2,
                    items: [
                        { number: 9, title: "self", state: "open", labels: [] },
                        {
                            number: 37235,
                            title: "delegate depth not enforced",
                            state: "closed",
                            labels: [{ name: "core" }],
                        },
                    ],
                };
            });

            const facts = await run(github, 9);
            expect(facts).toMatchObject({
                kind: "issue",
                titlePrefix: "delegate",
                author: {
                    login: "reporter",
                    association: "NONE",
                    bot: false,
                    teamMember: false,
                    priorIssues: 3,
                    priorPulls: 0,
                },
                labels: ["needs:compliance"],
                assignees: ["maintainer"],
                comments: {
                    count: 1,
                    commenters: ["github-actions[bot]"],
                    complianceComment: true,
                    duplicateComment: false,
                },
                pull: null,
            });
            expect(facts.body.environment.versionLine).toBe("v2");
            expect(facts.duplicateCandidates).toEqual([
                {
                    number: 37235,
                    title: "delegate depth not enforced",
                    state: "closed",
                    labels: ["core"],
                    titleMatches: 5,
                    errorMatch: true,
                },
            ]);
            expect(
                searches.filter((query) => query.includes("in:title")),
            ).toHaveLength(5);
            expect(
                searches.some((query) =>
                    query.includes(
                        '"Delegate depth limit reached (1). Increase the limit to allow nesting."',
                    ),
                ),
            ).toBe(true);
            // Every token was restricted to the one repository and minimal permissions.
            expect(
                new Set(
                    github.tokenRequests.map((request) =>
                        JSON.stringify(request),
                    ),
                ),
            ).toEqual(
                new Set([
                    JSON.stringify({
                        repositories: ["widgets"],
                        permissions: TOKEN_PERMISSIONS,
                    }),
                ]),
            );
            expect(github.comments).toEqual([]);
        } finally {
            await github.close();
        }
    });

    it("collects pull request facts", async () => {
        const github = await fakeGitHub();
        try {
            github.routes.set(`/repos/${REPO}/issues/12`, () =>
                issueJson({
                    number: 12,
                    title: "fix(tui): keep scroll position",
                    body: "Fixes #9.",
                    author_association: "CONTRIBUTOR",
                    labels: [],
                    assignees: [],
                    comments: 0,
                    pull_request: { url: "x" },
                }),
            );
            github.routes.set(`/repos/${REPO}/issues/12/comments`, () => []);
            github.routes.set(`/repos/${REPO}/pulls/12`, () => ({
                draft: false,
                additions: 40,
                deletions: 3,
                changed_files: 2,
                base: { ref: "dev", repo: { full_name: REPO } },
                head: { repo: { full_name: "reporter/widgets" } },
            }));
            github.routes.set(`/repos/${REPO}/pulls/12/files`, () => [
                { filename: "packages/tui/src/scroll.ts" },
                { filename: "packages/tui/test/scroll.test.ts" },
            ]);
            github.routes.set("/search/issues", () => ({
                total_count: 1,
                items: [],
            }));

            const facts = await run(github, 12);
            expect(facts.kind).toBe("pull");
            expect(facts.titlePrefix).toBe("fix(tui)");
            expect(facts.author.priorPulls).toBe(0);
            expect(facts.pull).toEqual({
                draft: false,
                fromFork: true,
                baseRef: "dev",
                additions: 40,
                deletions: 3,
                changedFiles: 2,
                files: [
                    "packages/tui/src/scroll.ts",
                    "packages/tui/test/scroll.test.ts",
                ],
                packages: ["packages/tui"],
                testsChanged: true,
                docsOnly: false,
                closesIssues: [9],
            });
        } finally {
            await github.close();
        }
    });
});
