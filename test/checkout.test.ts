import { execFileSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Repository } from "../src/conversations/repository";
import {
    eventually,
    fakeGitHub,
    issueComment,
    runBot,
    send,
    signed,
    tempDirectory,
} from "./support";

const git = (cwd: string, ...args: string[]) =>
    execFileSync("git", args, {
        cwd,
        env: {
            PATH: process.env.PATH,
            GIT_CONFIG_GLOBAL: "/dev/null",
            GIT_AUTHOR_NAME: "fixture",
            GIT_AUTHOR_EMAIL: "fixture@example.invalid",
            GIT_COMMITTER_NAME: "fixture",
            GIT_COMMITTER_EMAIL: "fixture@example.invalid",
        },
        encoding: "utf8",
    }).trim();

/** A bare "GitHub" repository with `main` and `refs/pull/7/head`. */
const makeRemote = async (root: string) => {
    const work = join(root, "work");
    const bare = join(root, "remote", "acme", "widgets.git");
    execFileSync("mkdir", ["-p", work, bare]);
    git(bare, "init", "--bare", "-q", "-b", "main");
    git(work, "init", "-q", "-b", "main");
    await writeFile(join(work, "README.md"), "base\n");
    git(work, "add", ".");
    git(work, "commit", "-q", "-m", "base");
    git(work, "push", "-q", bare, "main");
    const base = git(work, "rev-parse", "HEAD");
    const pushHead = async (content: string) => {
        await writeFile(join(work, "feature.txt"), content);
        git(work, "add", ".");
        git(work, "commit", "-q", "-m", content);
        git(work, "push", "-q", "--force", bare, "HEAD:refs/pull/7/head");
        return git(work, "rev-parse", "HEAD");
    };
    return { url: `file://${join(root, "remote")}`, base, pushHead };
};

const ok = (llm: TestLLM.TestInterface) => llm.always(TestLLM.text("ok", "t"));

it("checks out the pull request without credentials and keeps local work", async () => {
    await using directory = await tempDirectory();
    const github = await fakeGitHub();
    const remote = await makeRemote(directory.path);
    const first = await remote.pushHead("v1\n");
    try {
        await runBot(
            directory.path,
            github,
            () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({ id: 1, body: "@opencode-bot look" }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 1);
                    const [conversation] = (yield* Repository).conversations();
                    const repo = join(
                        directory.path,
                        "workspaces",
                        conversation?.workspaceId ?? "",
                        "repo",
                    );
                    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
                        "pr-7",
                    );
                    expect(git(repo, "rev-parse", "HEAD")).toBe(first);
                    expect(git(repo, "rev-parse", "refs/remotes/pr/base")).toBe(
                        remote.base,
                    );
                    // No credentials or remotes are configured in the workspace.
                    expect(git(repo, "remote")).toBe("");
                    const config = yield* Effect.promise(() =>
                        readFile(join(repo, ".git", "config"), "utf8"),
                    );
                    expect(config).not.toMatch(
                        /token|extraheader|authorization/i,
                    );

                    // Local edits survive while pr/head refreshes on the next turn.
                    yield* Effect.promise(() =>
                        writeFile(join(repo, "local.txt"), "mine"),
                    );
                    const second = yield* Effect.promise(() =>
                        remote.pushHead("v2\n"),
                    );
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 2,
                                body: "@opencode-bot again",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 2);
                    expect(git(repo, "rev-parse", "refs/remotes/pr/head")).toBe(
                        second,
                    );
                    expect(git(repo, "rev-parse", "HEAD")).toBe(first);
                    expect(
                        yield* Effect.promise(() =>
                            readFile(join(repo, "local.txt"), "utf8"),
                        ),
                    ).toBe("mine");
                }),
            ok,
            { gitUrl: remote.url },
        );
    } finally {
        await github.close();
    }
});

it("checks out the default branch for an issue", async () => {
    await using directory = await tempDirectory();
    const github = await fakeGitHub();
    const remote = await makeRemote(directory.path);
    try {
        await runBot(
            directory.path,
            github,
            () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 1,
                                pull: 9,
                                plainIssue: true,
                                body: "@opencode-bot look",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 1);
                    const [conversation] = (yield* Repository).conversations();
                    const repo = join(
                        directory.path,
                        "workspaces",
                        conversation?.workspaceId ?? "",
                        "repo",
                    );
                    expect(git(repo, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
                        "issue-9",
                    );
                    expect(git(repo, "rev-parse", "HEAD")).toBe(remote.base);
                    expect(git(repo, "rev-parse", "refs/remotes/default")).toBe(
                        remote.base,
                    );
                    expect(git(repo, "remote")).toBe("");
                }),
            ok,
            { gitUrl: remote.url },
        );
    } finally {
        await github.close();
    }
});
