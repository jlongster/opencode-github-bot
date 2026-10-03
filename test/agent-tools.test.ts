import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { expect, it } from "vitest";
import {
    eventually,
    fakeGitHub,
    issueComment,
    runBot,
    send,
    signed,
    tempDirectory,
} from "./support";

it("offers the model only workspace tools", async () => {
    await using directory = await tempDirectory();
    const github = await fakeGitHub();
    try {
        await runBot(
            directory.path,
            github,
            (llm) =>
                Effect.gen(function* () {
                    yield* send(
                        signed(
                            "issue_comment",
                            issueComment({ id: 1, body: "@opencode-bot hi" }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 1);
                    const tools = (yield* llm.requests())
                        .filter((request) => request.tools.length > 0)
                        .flatMap((request) =>
                            request.tools.map((tool) => tool.name),
                        );
                    expect(tools).toContain("shell");
                    for (const disabled of [
                        "question",
                        "execute",
                        "webfetch",
                        "websearch",
                    ])
                        expect(tools).not.toContain(disabled);
                }),
            (llm) => llm.always(TestLLM.text("ok", "t")),
        );
    } finally {
        await github.close();
    }
});
