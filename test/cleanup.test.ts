import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { Effect, Layer } from "effect";
import { describe, expect, it } from "vitest";
import {
    CLOSED_RETENTION_MS,
    cleanupClosedWorkspaces,
} from "../src/conversations/cleanup";
import { Repository } from "../src/conversations/repository";
import { GitHub } from "../src/github/client";
import {
    eventually,
    type FakeGitHub,
    fakeGitHub,
    issueComment,
    privateKey,
    reviewComment,
    runBot,
    send,
    signed,
    tempDirectory,
} from "./support";

const DAY = 24 * 60 * 60 * 1000;

const withState =
    (body: (directory: string, github: FakeGitHub) => Promise<void>) =>
    async () => {
        await using directory = await tempDirectory();
        const github = await fakeGitHub();
        try {
            await body(directory.path, github);
        } finally {
            await github.close();
        }
    };

/** Runs the daily cleanup job as its own process would. */
const runCleanup = (directory: string, github: FakeGitHub) => {
    const requested: string[] = [];
    return Effect.runPromise(
        cleanupClosedWorkspaces({
            closedForMs: CLOSED_RETENTION_MS,
            requestDeletion: (workspaceId) =>
                Effect.sync(() => {
                    requested.push(workspaceId);
                }),
        }).pipe(
            Effect.provide(
                Layer.mergeAll(
                    Repository.layer(join(directory, "state", "bot.sqlite")),
                    GitHub.layer({ apiUrl: github.url, appId: 1, privateKey }),
                ),
            ),
            Effect.map((deleted) => ({ deleted, requested })),
        ),
    );
};

describe("closed pull request workspace cleanup", () => {
    it(
        "deletes workspaces only for pull requests and issues closed over seven days",
        withState(async (directory, github) => {
            // Conversations on four open pull requests.
            await runBot(directory, github, () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 1,
                                pull: 7,
                                body: "@opencode-bot a",
                            }),
                        ),
                    );
                    yield* send(
                        signed(
                            "pull_request_review_comment",
                            reviewComment({
                                id: 2,
                                pull: 7,
                                body: "@opencode-bot b",
                            }),
                        ),
                    );
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 3,
                                pull: 8,
                                body: "@opencode-bot c",
                            }),
                        ),
                    );
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 4,
                                pull: 9,
                                body: "@opencode-bot d",
                            }),
                        ),
                    );
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 5,
                                pull: 10,
                                body: "@opencode-bot e",
                            }),
                        ),
                    );
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 6,
                                pull: 11,
                                plainIssue: true,
                                body: "@opencode-bot f",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 6);
                }),
            );
            github.states.set(7, {
                state: "closed",
                closedAt: Date.now() - 8 * DAY,
            });
            github.states.set(8, {
                state: "closed",
                closedAt: Date.now() - 2 * DAY,
            });
            github.states.set(9, { state: "open" }); // reopened
            github.states.set(11, {
                state: "closed",
                closedAt: Date.now() - 9 * DAY,
            });
            // Pull 10 lookups fail; it is retried on the next daily run.
            github.states.set(10, {
                state: "closed",
                closedAt: Date.now() - 30 * DAY,
            });
            github.state.failStateLookups.add(10);

            const first = await runCleanup(directory, github);
            expect(first.deleted.sort()).toEqual([
                "github:11:22:issue:11:conversation",
                "github:11:22:pull:7:conversation",
                "github:11:22:pull:7:review:2",
            ]);
            expect(first.requested).toHaveLength(3);

            // Already-deleted workspaces are not requested again.
            github.state.failStateLookups.clear();
            const second = await runCleanup(directory, github);
            expect(second.deleted).toEqual([
                "github:11:22:pull:10:conversation",
            ]);
        }),
    );

    it(
        "ignores comments on closed pull requests and rebuilds a reopened workspace",
        withState(async (directory, github) => {
            await runBot(directory, github, () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 1,
                                body: "@opencode-bot comment-marker-first",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 1);
                }),
            );
            github.states.set(7, {
                state: "closed",
                closedAt: Date.now() - 8 * DAY,
            });
            expect((await runCleanup(directory, github)).deleted).toHaveLength(
                1,
            );

            await runBot(directory, github, (llm) =>
                Effect.gen(function* () {
                    const repository = yield* Repository;
                    const key = "github:11:22:pull:7:conversation";
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 2,
                                state: "closed",
                                body: "@opencode-bot ignored",
                            }),
                        ),
                    );
                    yield* Effect.sleep("500 millis");
                    expect(github.comments).toHaveLength(1);
                    expect(repository.inboxItems(key)).toHaveLength(1);

                    // Reopened: the next mention is answered in a fresh workspace,
                    // continuing the same OpenCode session.
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 3,
                                body: "@opencode-bot comment-marker-again",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 2);
                    expect(github.comments[1]?.body).toContain(
                        "reply to again",
                    );
                    const prompts = JSON.stringify(
                        (yield* llm.requests()).map(
                            (request) => request.messages,
                        ),
                    );
                    expect(prompts).toContain(
                        "has been recreated with a fresh checkout",
                    );
                    expect(
                        repository.conversation(key)?.workspaceDeletedAt,
                    ).toBeNull();
                }),
            );
        }),
    );

    it(
        "interrupts a running turn when its workspace is deleted, without replying",
        withState(async (directory, github) => {
            await runBot(
                directory,
                github,
                (llm) =>
                    Effect.gen(function* () {
                        const repository = yield* Repository;
                        const key = "github:11:22:pull:7:conversation";
                        yield* send(
                            signed(
                                "issue_comment",
                                issueComment({
                                    id: 1,
                                    body: "@opencode-bot slow",
                                }),
                            ),
                        );
                        yield* eventually(
                            () =>
                                repository.inboxItems(key)[0]?.status ===
                                "admitted",
                        );
                        yield* llm.wait(1);
                        repository.setWorkspaceDeleted(key, true);
                        yield* eventually(
                            () =>
                                repository.inboxItems(key)[0]?.status ===
                                "failed",
                        );
                        yield* Effect.sleep("300 millis");
                        expect(github.comments).toEqual([]);
                    }),
                (llm) => llm.always(TestLLM.hangAfter()),
            );
        }),
    );
});
