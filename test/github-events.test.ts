import { Option } from "effect";
import { describe, expect, it } from "vitest";
import { verifyWebhookSignature } from "../src/github/auth";
import { decodeCommentEvent } from "../src/github/events";
import {
    ignoredReason,
    mentions,
    reviewConversationKey,
    topLevelConversationKey,
} from "../src/github/threads";
import {
    BOT,
    issueComment,
    reviewComment,
    SECRET,
    signed,
    stranger,
} from "./support";

describe("GitHub events", () => {
    it("normalizes pull-request and issue comments", () => {
        const top = Option.getOrThrow(
            decodeCommentEvent(
                "issue_comment",
                issueComment({ id: 1, body: "hi" }),
            ),
        );
        expect(topLevelConversationKey(top)).toBe(
            "github:11:22:pull:7:conversation",
        );

        const inline = Option.getOrThrow(
            decodeCommentEvent(
                "pull_request_review_comment",
                reviewComment({ id: 5, body: "x", inReplyTo: 3 }),
            ),
        );
        expect(inline).toMatchObject({
            kind: "review",
            inReplyToId: 3,
            path: "src/index.ts",
        });
        expect(reviewConversationKey(inline, 3)).toBe(
            "github:11:22:pull:7:review:3",
        );

        const issue = Option.getOrThrow(
            decodeCommentEvent(
                "issue_comment",
                issueComment({ id: 2, body: "hi", pull: 9, plainIssue: true }),
            ),
        );
        expect(issue).toMatchObject({
            kind: "issue",
            target: "issue",
            number: 9,
        });
        expect(topLevelConversationKey(issue)).toBe(
            "github:11:22:issue:9:conversation",
        );
        expect(Option.isNone(decodeCommentEvent("push", {}))).toBe(true);
    });

    it("detects mentions and filters bots, edits and other installations", () => {
        expect(mentions("hey @opencode-bot look", "opencode-bot")).toBe(true);
        expect(mentions("@OpenCode-Bot", "opencode-bot")).toBe(true);
        expect(mentions("@opencode-bot-two", "opencode-bot")).toBe(false);
        expect(mentions("me@opencode-bot.com", "opencode-bot")).toBe(false);

        const event = (payload: unknown) =>
            Option.getOrThrow(decodeCommentEvent("issue_comment", payload));
        expect(
            ignoredReason(
                event(issueComment({ id: 1, body: "@opencode-bot" })),
                BOT,
            ),
        ).toBe(undefined);
        expect(
            ignoredReason(
                event(
                    issueComment({
                        id: 1,
                        body: "x",
                        user: {
                            id: 3003,
                            login: "opencode-bot[bot]",
                            type: "Bot",
                        },
                    }),
                ),
                BOT,
            ),
        ).toBe("bot-author");
        expect(
            ignoredReason(
                event(issueComment({ id: 1, body: "x", action: "edited" })),
                BOT,
            ),
        ).toBe("comment-edited");
        expect(
            ignoredReason(event(issueComment({ id: 1, body: "x" })), {
                ...BOT,
                allowedInstallations: [99],
            }),
        ).toBe("installation-not-allowed");
        expect(
            ignoredReason(
                event(
                    issueComment({
                        id: 1,
                        body: "@opencode-bot",
                        user: stranger,
                    }),
                ),
                BOT,
            ),
        ).toBe("user-not-allowed");
        expect(
            ignoredReason(
                event(
                    issueComment({
                        id: 1,
                        body: "@opencode-bot",
                        state: "closed",
                    }),
                ),
                BOT,
            ),
        ).toBe("closed");
    });

    it("verifies webhook signatures over exact bytes", () => {
        const request = signed("issue_comment", { a: 1 });
        expect(
            verifyWebhookSignature(SECRET, request.body, request.signature),
        ).toBe(true);
        expect(
            verifyWebhookSignature("other", request.body, request.signature),
        ).toBe(false);
        expect(
            verifyWebhookSignature(
                SECRET,
                new Uint8Array([1]),
                request.signature,
            ),
        ).toBe(false);
        expect(verifyWebhookSignature(SECRET, request.body, undefined)).toBe(
            false,
        );
    });
});
