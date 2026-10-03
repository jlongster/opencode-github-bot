import type { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Repository } from "../src/conversations/repository";
import {
    type BotServices,
    eventually,
    type FakeGitHub,
    fakeGitHub,
    issueComment,
    reviewComment,
    runBot,
    send,
    signed,
    stranger,
    tempDirectory,
} from "./support";

const withBot =
    <A, E>(
        body: (input: {
            readonly github: FakeGitHub;
            readonly llm: TestLLM.TestInterface;
        }) => Effect.Effect<A, E, BotServices>,
    ) =>
    async () => {
        await using directory = await tempDirectory();
        const github = await fakeGitHub();
        try {
            await runBot(directory.path, github, (llm) =>
                body({ github, llm }),
            );
        } finally {
            await github.close();
        }
    };

const replies = (github: FakeGitHub, count: number) =>
    eventually(() => github.comments.length >= count && github.comments);

describe("webhook intake", () => {
    it(
        "rejects bad signatures and records unsupported events without content",
        withBot(() =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                const good = signed(
                    "issue_comment",
                    issueComment({ id: 1, body: "@opencode-bot hi" }),
                );
                expect(yield* send({ ...good, signature: "sha256=00" })).toBe(
                    401,
                );
                expect(yield* send({ ...good, event: undefined })).toBe(400);
                expect(yield* send(signed("ping", {}))).toBe(204);
                expect(yield* send(signed("push", { ref: "main" }))).toBe(202);
                expect(repository.receivedDeliveries()).toEqual([]);
                expect(repository.conversations()).toEqual([]);
            }),
        ),
    );

    it(
        "creates one inbox item and one reply for a replayed delivery",
        withBot(({ github }) =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                const request = signed(
                    "issue_comment",
                    issueComment({
                        id: 100,
                        body: "@opencode-bot comment-marker-one",
                    }),
                );
                expect(yield* send(request)).toBe(202);
                expect(yield* send(request)).toBe(202);
                // A redelivery with a new delivery ID for the same comment.
                expect(
                    yield* send({ ...request, deliveryId: "redelivered" }),
                ).toBe(202);
                const [comment] = yield* replies(github, 1);
                expect(comment?.body).toContain("reply to one");
                expect(comment?.body).toContain(
                    "<!-- opencode-github-bot:reply:issue-comment:100 -->",
                );
                yield* Effect.sleep("500 millis");
                expect(github.comments).toHaveLength(1);
                const [conversation] = repository.conversations();
                expect(
                    repository.inboxItems(conversation?.key ?? ""),
                ).toHaveLength(1);
            }),
        ),
    );
});

describe("conversation routing", () => {
    it(
        "shares one session across top-level comments on a pull request",
        withBot(({ github }) =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({
                            id: 1,
                            body: "@opencode-bot comment-marker-a",
                        }),
                    ),
                );
                yield* replies(github, 1);
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({ id: 2, body: "no mention here" }),
                    ),
                );
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({
                            id: 3,
                            body: "@opencode-bot comment-marker-b",
                        }),
                    ),
                );
                yield* replies(github, 2);
                const conversations = repository.conversations();
                expect(conversations.map((c) => c.key)).toEqual([
                    "github:11:22:pull:7:conversation",
                ]);
                expect(
                    repository.inboxItems(conversations[0]?.key ?? ""),
                ).toHaveLength(2);
                expect(
                    github.comments.map((c) => [c.kind, c.inReplyTo]),
                ).toEqual([
                    ["issue", null],
                    ["issue", null],
                ]);
            }),
        ),
    );

    it(
        "gives each plain issue one conversation and replies on the issue",
        withBot(({ github }) =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                const comment = (id: number, body: string) =>
                    send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id,
                                pull: 9,
                                plainIssue: true,
                                body,
                            }),
                        ),
                    );
                yield* comment(1, "@opencode-bot comment-marker-issueone");
                yield* replies(github, 1);
                yield* comment(2, "no mention, ignored");
                yield* comment(3, "@opencode-bot comment-marker-issuetwo");
                yield* replies(github, 2);
                const [conversation] = repository.conversations();
                expect(conversation).toMatchObject({
                    key: "github:11:22:issue:9:conversation",
                    target: "issue",
                    number: 9,
                    rootCommentId: null,
                });
                expect(
                    repository.inboxItems(conversation?.key ?? ""),
                ).toHaveLength(2);
                expect(github.comments.map((c) => [c.kind, c.pull])).toEqual([
                    ["issue", 9],
                    ["issue", 9],
                ]);
                expect(github.comments[1]?.body).toContain("reply to issuetwo");
            }),
        ),
    );

    it(
        "gives each inline thread its own session and keeps replies in the thread",
        withBot(({ github }) =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                const review = (payload: unknown) =>
                    send(signed("pull_request_review_comment", payload));
                yield* review(
                    reviewComment({
                        id: 10,
                        body: "@opencode-bot comment-marker-ten",
                    }),
                );
                yield* review(
                    reviewComment({
                        id: 20,
                        body: "@opencode-bot comment-marker-twenty",
                    }),
                );
                yield* replies(github, 2);
                // A reply without a mention continues the thread the bot owns.
                yield* review(
                    reviewComment({
                        id: 11,
                        body: "comment-marker-eleven",
                        inReplyTo: 10,
                    }),
                );
                // An unowned thread without a mention is ignored.
                yield* review(reviewComment({ id: 30, body: "just a note" }));
                yield* review(
                    reviewComment({ id: 31, body: "reply", inReplyTo: 30 }),
                );
                yield* replies(github, 3);
                yield* Effect.sleep("300 millis");

                const keys = repository.conversations().map((c) => c.key);
                expect(keys).toEqual([
                    "github:11:22:pull:7:review:10",
                    "github:11:22:pull:7:review:20",
                ]);
                const sessions = new Set(
                    repository.conversations().map((c) => c.sessionId),
                );
                expect(sessions.size).toBe(2);
                expect(
                    repository.inboxItems("github:11:22:pull:7:review:10"),
                ).toHaveLength(2);
                const threadReplies = github.comments.map((c) => [
                    c.kind,
                    c.inReplyTo,
                ]);
                expect(threadReplies).toHaveLength(3);
                expect(threadReplies).toEqual(
                    expect.arrayContaining([
                        ["review", 10],
                        ["review", 20],
                        ["review", 10],
                    ]),
                );
                expect(
                    github.comments.find((c) =>
                        c.body.includes("reply to eleven"),
                    )?.inReplyTo,
                ).toBe(10);
            }),
        ),
    );

    it(
        "resolves an unknown inline parent through GitHub",
        withBot(({ github }) =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                github.reviewParents.set(41, 40);
                github.reviewParents.set(40, null);
                yield* send(
                    signed(
                        "pull_request_review_comment",
                        reviewComment({
                            id: 42,
                            body: "@opencode-bot comment-marker-deep",
                            inReplyTo: 41,
                        }),
                    ),
                );
                const [comment] = yield* replies(github, 1);
                expect(comment?.inReplyTo).toBe(40);
                expect(repository.conversations().map((c) => c.key)).toEqual([
                    "github:11:22:pull:7:review:40",
                ]);
            }),
        ),
    );

    it(
        "ignores everyone who is not on the user allowlist",
        withBot(({ github }) =>
            Effect.gen(function* () {
                const repository = yield* Repository;
                // A stranger mentioning the bot on a pull request and an issue.
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({
                            id: 1,
                            body: "@opencode-bot hi",
                            user: stranger,
                        }),
                    ),
                );
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({
                            id: 2,
                            pull: 9,
                            plainIssue: true,
                            body: "@opencode-bot hi",
                            user: stranger,
                        }),
                    ),
                );
                // An allowed user starts an inline thread; a stranger replies in it.
                yield* send(
                    signed(
                        "pull_request_review_comment",
                        reviewComment({
                            id: 10,
                            body: "@opencode-bot comment-marker-allowed",
                        }),
                    ),
                );
                yield* replies(github, 1);
                yield* send(
                    signed(
                        "pull_request_review_comment",
                        reviewComment({
                            id: 11,
                            inReplyTo: 10,
                            body: "@opencode-bot comment-marker-stranger",
                            user: stranger,
                        }),
                    ),
                );
                yield* Effect.sleep("500 millis");
                expect(github.comments).toHaveLength(1);
                expect(github.comments[0]?.body).toContain("reply to allowed");
                expect(repository.conversations().map((c) => c.key)).toEqual([
                    "github:11:22:pull:7:review:10",
                ]);
                expect(
                    repository.inboxItems("github:11:22:pull:7:review:10"),
                ).toHaveLength(1);
            }),
        ),
    );

    it(
        "ignores bot-authored comments and its own echoed replies",
        withBot(({ github }) =>
            Effect.gen(function* () {
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({
                            id: 5,
                            body: "@opencode-bot loop?",
                            user: {
                                id: 3004,
                                login: "other[bot]",
                                type: "Bot",
                            },
                        }),
                    ),
                );
                yield* send(
                    signed(
                        "issue_comment",
                        issueComment({
                            id: 6,
                            body: "@opencode-bot\n<!-- opencode-github-bot:reply:x -->",
                        }),
                    ),
                );
                yield* Effect.sleep("500 millis");
                expect(github.comments).toEqual([]);
                expect((yield* Repository).conversations()).toEqual([]);
            }),
        ),
    );
});
