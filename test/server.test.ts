import { NodeHttpServer } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { HttpServer } from "effect/unstable/http";
import { expect, it } from "vitest";
import { Repository } from "../src/conversations/repository";
import { serverLayer } from "../src/server";
import {
    eventually,
    fakeGitHub,
    issueComment,
    runBot,
    signed,
    tempDirectory,
} from "./support";

it("serves health and accepts only signed webhooks over HTTP", async () => {
    await using directory = await tempDirectory();
    const github = await fakeGitHub();
    try {
        await runBot(directory.path, github, () =>
            Effect.gen(function* () {
                const origin = yield* HttpServer.addressFormattedWith(
                    Effect.succeed,
                );
                const health = yield* Effect.promise(() =>
                    fetch(`${origin}/health`),
                );
                expect(health.status).toBe(200);

                const request = signed(
                    "issue_comment",
                    issueComment({
                        id: 1,
                        body: "@opencode-bot comment-marker-http",
                    }),
                );
                const post = (signature: string) =>
                    Effect.promise(() =>
                        fetch(`${origin}/github/webhook`, {
                            method: "POST",
                            headers: {
                                "x-github-event": request.event,
                                "x-github-delivery": request.deliveryId,
                                "x-hub-signature-256": signature,
                            },
                            body: request.body,
                        }),
                    );
                expect((yield* post("sha256=bad")).status).toBe(401);
                expect((yield* post(request.signature)).status).toBe(202);
                yield* eventually(() => github.comments.length === 1);
                expect((yield* Repository).conversations()).toHaveLength(1);
            }).pipe(
                Effect.provide(
                    serverLayer.pipe(
                        Layer.provideMerge(NodeHttpServer.layerTest),
                    ),
                ),
            ),
        );
    } finally {
        await github.close();
    }
});
