import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { makeGitHub, TOKEN_PERMISSIONS } from "../src/github/client";
import { fakeGitHub, privateKey } from "./support";

const repo = { installationId: 11, repository: "acme/widgets" };

it("requests repository-restricted tokens with only the bot's permissions", async () => {
    const github = await fakeGitHub();
    try {
        const client = makeGitHub({ apiUrl: github.url, appId: 1, privateKey });
        await Effect.runPromise(client.createIssueComment(repo, 7, "hello"));
        await Effect.runPromise(client.createIssueComment(repo, 7, "again"));
        // One token, reused, scoped to the repository and minimal permissions.
        expect(github.tokenRequests).toEqual([
            { repositories: ["widgets"], permissions: TOKEN_PERMISSIONS },
        ]);
        expect(github.comments).toHaveLength(2);
    } finally {
        await github.close();
    }
});

it("refuses a token that GitHub granted broader access", async () => {
    const github = await fakeGitHub();
    try {
        github.state.extraTokenPermissions = { workflows: "write" };
        const client = makeGitHub({ apiUrl: github.url, appId: 1, privateKey });
        const exit = await Effect.runPromiseExit(
            client.createIssueComment(repo, 7, "should not post"),
        );
        expect(Exit.isFailure(exit)).toBe(true);
        expect(github.comments).toEqual([]);
    } finally {
        await github.close();
    }
});
