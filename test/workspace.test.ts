import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { TestLLM } from "@opencode/ai/testing";
import { Effect } from "effect";
import { expect, it } from "vitest";
import { Repository } from "../src/conversations/repository";
import {
    eventually,
    fakeGitHub,
    issueComment,
    reviewComment,
    runBot,
    send,
    signed,
    tempDirectory,
} from "./support";

/** Main-agent requests run one shell command named in the comment, then answer. */
const shellModel = (llm: TestLLM.TestInterface) =>
    llm.serve((request) => {
        const last = request.messages.at(-1) as { role?: string } | undefined;
        if (request.tools.length === 0) return TestLLM.text("title", "t");
        if (last?.role === "tool") return TestLLM.text("done", "t");
        const marker = [
            ...JSON.stringify(request.messages).matchAll(/write-(\w+)/g),
        ].at(-1)?.[1];
        return TestLLM.tool("call-1", "shell", {
            command: `printf ${marker} > note.txt && printf "$HOME" > home.txt && printf "\${CONTROL_SENTINEL:-absent}" > env.txt`,
            description: "write note",
        });
    });

it("runs native OpenCode tools inside each conversation's own workspace", async () => {
    process.env.CONTROL_SENTINEL = "control-only";
    await using directory = await tempDirectory();
    const github = await fakeGitHub();
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
                                body: "@opencode-bot write-alpha",
                            }),
                        ),
                    );
                    yield* send(
                        signed(
                            "pull_request_review_comment",
                            reviewComment({
                                id: 2,
                                body: "@opencode-bot write-beta",
                            }),
                        ),
                    );
                    yield* eventually(() => github.comments.length === 2);
                    const [top, inline] = (yield* Repository).conversations();
                    const root = (id: string | undefined) =>
                        join(directory.path, "workspaces", id ?? "");
                    const file = (id: string | undefined, name: string) =>
                        Effect.promise(() =>
                            readFile(join(root(id), name), "utf8"),
                        );
                    expect(yield* file(top?.workspaceId, "note.txt")).toBe(
                        "alpha",
                    );
                    expect(yield* file(inline?.workspaceId, "note.txt")).toBe(
                        "beta",
                    );
                    // HOME is set by the workspace executor, proving the tool ran over its socket.
                    expect(yield* file(top?.workspaceId, "home.txt")).toBe(
                        root(top?.workspaceId),
                    );
                    // The control process environment never reaches workspace processes.
                    expect(yield* file(top?.workspaceId, "env.txt")).toBe(
                        "absent",
                    );
                    expect(top?.workspaceId).not.toBe(inline?.workspaceId);
                }),
            shellModel,
        );
    } finally {
        delete process.env.CONTROL_SENTINEL;
        await github.close();
    }
});
