import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { Repository } from "../src/conversations/repository";
import {
    eventually,
    type FakeGitHub,
    fakeGitHub,
    issueComment,
    runBot,
    send,
    signed,
    tempDirectory,
} from "./support";

const KEY = "github:11:22:pull:7:conversation";

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

const userMessagesMentioning = (
    requests: ReadonlyArray<{ readonly messages: ReadonlyArray<unknown> }>,
    marker: string,
) =>
    Math.max(
        0,
        ...requests.map(
            (request) =>
                request.messages.filter(
                    (message) =>
                        (message as { role?: string }).role === "user" &&
                        JSON.stringify(message).includes(marker),
                ).length,
        ),
    );

describe("restart recovery", () => {
    it(
        "resumes an admitted turn after restart without re-prompting the model",
        withState(async (directory, github) => {
            await runBot(
                directory,
                github,
                (llm) =>
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
                        const repository = yield* Repository;
                        yield* eventually(
                            () =>
                                repository.inboxItems(KEY)[0]?.status ===
                                "admitted",
                        );
                        yield* llm.wait(1);
                    }),
                // The model never answers before the process stops.
                (llm) => llm.always(TestLLM.hangAfter()),
            );
            expect(github.comments).toEqual([]);

            await runBot(directory, github, (llm) =>
                Effect.gen(function* () {
                    const [reply] = yield* eventually(
                        () => github.comments.length > 0 && github.comments,
                    );
                    expect(reply?.body).toContain("reply to first");
                    expect(
                        userMessagesMentioning(
                            yield* llm.requests(),
                            "comment-marker-first",
                        ),
                    ).toBe(1);
                    expect((yield* Repository).inboxItems(KEY)[0]?.status).toBe(
                        "complete",
                    );
                }),
            );
        }),
    );

    it(
        "delivers persisted output after restart without asking the model again",
        withState(async (directory, github) => {
            github.state.hangPosts = true;
            await runBot(directory, github, () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 1,
                                body: "@opencode-bot comment-marker-saved",
                            }),
                        ),
                    );
                    const repository = yield* Repository;
                    yield* eventually(
                        () =>
                            repository.outbox("issue-comment:1")?.status ===
                            "submitting",
                    );
                }),
            );
            github.state.hangPosts = false;

            await runBot(
                directory,
                github,
                (llm) =>
                    Effect.gen(function* () {
                        const repository = yield* Repository;
                        yield* eventually(
                            () =>
                                repository.outbox("issue-comment:1")?.status ===
                                "submitted",
                        );
                        expect(github.comments).toHaveLength(1);
                        expect(github.comments[0]?.body).toContain(
                            "reply to saved",
                        );
                        expect(yield* llm.requests()).toEqual([]);
                    }),
                () => Effect.void,
            );
        }),
    );

    it(
        "keeps session history and never resubmits a confirmed reply",
        withState(async (directory, github) => {
            await runBot(directory, github, () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 1,
                                body: "@opencode-bot comment-marker-before",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 1);
                }),
            );

            await runBot(directory, github, (llm) =>
                Effect.gen(function* () {
                    yield* Effect.sleep("600 millis");
                    expect(github.comments).toHaveLength(1);
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 2,
                                body: "@opencode-bot comment-marker-after",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 2);
                    const context = JSON.stringify(
                        (yield* llm.requests()).map(
                            (request) => request.messages,
                        ),
                    );
                    expect(context).toContain("comment-marker-before");
                    expect(context).toContain("reply to before");
                }),
            );
        }),
    );
});

describe("reply reconciliation", () => {
    it(
        "reconciles a lost GitHub response by marker instead of reposting",
        withState(async (directory, github) => {
            github.state.dropNextPostResponse = true;
            await runBot(directory, github, () =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({
                                id: 1,
                                body: "@opencode-bot comment-marker-lost",
                            }),
                        ),
                    );
                    const repository = yield* Repository;
                    yield* eventually(
                        () =>
                            repository.outbox("issue-comment:1")?.status ===
                            "submitted",
                    );
                    yield* Effect.sleep("400 millis");
                    expect(github.comments).toHaveLength(1);
                }),
            );
        }),
    );
});
