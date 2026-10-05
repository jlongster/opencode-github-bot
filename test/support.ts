import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LLMClient } from "@opencode/ai";
import { TestLLM } from "@opencode/ai/testing";
import { llmClient } from "@opencode/core/effect/app-node-platform";
import { Effect, Layer, Schedule, Scope } from "effect";
import { AgentHost } from "../src/agent/host";
import { Repository } from "../src/conversations/repository";
import * as Conversations from "../src/conversations/service";
import { signWebhookBody } from "../src/github/auth";
import { makeCheckout } from "../src/github/checkout";
import { GitHub } from "../src/github/client";
import {
    acceptWebhook,
    type WebhookInput,
    WebhookSettings,
} from "../src/server";
import { serveWorkspace } from "../src/workspace/server";

export const SECRET = "fixture-webhook-secret";
export const BOT = {
    appSlug: "opencode-bot",
    allowedInstallations: [11],
    allowedUsers: [1001],
};

const repository = { id: 22, full_name: "acme/widgets" };
const installation = { id: 11 };
const human = { id: 1001, login: "octocat", type: "User" };
/** A real GitHub user who is not on the allowlist. */
export const stranger = { id: 2002, login: "mallory", type: "User" };

export const issueComment = (input: {
    readonly id: number;
    readonly body: string;
    readonly pull?: number;
    /** Comment on a plain issue instead of a pull request. */
    readonly plainIssue?: boolean;
    readonly state?: "open" | "closed";
    readonly user?: { id: number; login: string; type: string };
    readonly action?: string;
}) => ({
    action: input.action ?? "created",
    issue: {
        number: input.pull ?? 7,
        state: input.state ?? "open",
        ...(input.plainIssue ? {} : { pull_request: { url: "fixture" } }),
    },
    comment: { id: input.id, body: input.body, user: input.user ?? human },
    repository,
    installation,
});

export const reviewComment = (input: {
    readonly id: number;
    readonly body: string;
    readonly inReplyTo?: number;
    readonly pull?: number;
    readonly state?: "open" | "closed";
    readonly user?: { id: number; login: string; type: string };
}) => ({
    action: "created",
    pull_request: { number: input.pull ?? 7, state: input.state ?? "open" },
    comment: {
        id: input.id,
        body: input.body,
        user: input.user ?? human,
        path: "src/index.ts",
        line: 12,
        diff_hunk: "@@ -1,2 +1,2 @@\n-old\n+new",
        ...(input.inReplyTo === undefined
            ? {}
            : { in_reply_to_id: input.inReplyTo }),
    },
    repository,
    installation,
});

let deliveryCounter = 0;
export const signed = (
    event: string,
    payload: unknown,
    deliveryId = `delivery-${++deliveryCounter}`,
) => {
    const body = new TextEncoder().encode(JSON.stringify(payload));
    return {
        event,
        deliveryId,
        signature: signWebhookBody(SECRET, body),
        body,
    };
};

export type FakeComment = {
    readonly id: number;
    readonly kind: "issue" | "review";
    readonly pull: number;
    readonly body: string;
    readonly inReplyTo: number | null;
};

/** In-memory stand-in for the small GitHub REST surface the bot uses. */
export const fakeGitHub = async () => {
    const comments: FakeComment[] = [];
    /** Test-specific GET responses by path; they take precedence over built-in routes. */
    const routes = new Map<string, (url: URL) => unknown>();
    const tokenRequests: Array<{
        repositories?: string[];
        permissions?: Record<string, string>;
    }> = [];
    const reviewParents = new Map<number, number | null>();
    /** Pull request and issue states by number (default: open). */
    const states = new Map<
        number,
        { readonly state: "open" | "closed"; readonly closedAt?: number }
    >();
    const state = {
        dropNextPostResponse: false,
        hangPosts: false,
        failStateLookups: new Set<number>(),
        /** Simulates GitHub granting more than was requested. */
        extraTokenPermissions: {} as Record<string, string>,
        nextId: 9_000,
    };
    const readBody = (request: IncomingMessage) =>
        new Promise<string>((resolve) => {
            let text = "";
            request.on("data", (chunk) => {
                text += chunk;
            });
            request.on("end", () => resolve(text));
        });
    const server = createServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://fake");
        const send = (status: number, value: unknown) => {
            response.writeHead(status, { "content-type": "application/json" });
            response.end(JSON.stringify(value));
        };
        const body = await readBody(request);
        const route =
            request.method === "GET" ? routes.get(url.pathname) : undefined;
        if (route) return send(200, route(url));
        if (
            request.method === "POST" &&
            /^\/app\/installations\/\d+\/access_tokens$/.test(url.pathname)
        ) {
            const requested = JSON.parse(body || "{}") as {
                repositories?: string[];
                permissions?: Record<string, string>;
            };
            tokenRequests.push(requested);
            return send(201, {
                token: "fixture-installation-token",
                expires_at: new Date(Date.now() + 3_600_000).toISOString(),
                permissions: {
                    ...requested.permissions,
                    ...state.extraTokenPermissions,
                },
                repositories: (requested.repositories ?? []).map((name) => ({
                    full_name: `acme/${name}`,
                })),
            });
        }
        const single = url.pathname.match(
            /^\/repos\/[^/]+\/[^/]+\/pulls\/comments\/(\d+)$/,
        );
        if (request.method === "GET" && single) {
            const id = Number(single[1]);
            if (!reviewParents.has(id)) return send(404, {});
            const parent = reviewParents.get(id);
            return send(200, {
                id,
                ...(parent ? { in_reply_to_id: parent } : {}),
            });
        }
        const pullRequest = url.pathname.match(
            /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)$/,
        );
        const issue = url.pathname.match(
            /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)$/,
        );
        if (request.method === "GET" && (pullRequest || issue)) {
            const number = Number((pullRequest ?? issue)?.[1]);
            if (issue && state.failStateLookups.has(number))
                return send(502, {});
            const thread = states.get(number);
            return send(200, {
                state: thread?.state ?? "open",
                closed_at: thread?.closedAt
                    ? new Date(thread.closedAt).toISOString()
                    : null,
                base: { ref: "main" },
                head: { sha: "fixture" },
            });
        }
        if (
            request.method === "GET" &&
            /^\/repos\/[^/]+\/[^/]+$/.test(url.pathname)
        )
            return send(200, { default_branch: "main" });
        const issueList = url.pathname.match(
            /^\/repos\/[^/]+\/[^/]+\/issues\/(\d+)\/comments$/,
        );
        const reviewList = url.pathname.match(
            /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments$/,
        );
        const reply = url.pathname.match(
            /^\/repos\/[^/]+\/[^/]+\/pulls\/(\d+)\/comments\/(\d+)\/replies$/,
        );
        if (request.method === "GET" && (issueList || reviewList)) {
            const kind = issueList ? "issue" : "review";
            const pull = Number((issueList ?? reviewList)?.[1]);
            return send(
                200,
                comments
                    .filter((c) => c.kind === kind && c.pull === pull)
                    .map((c) => ({ id: c.id, body: c.body })),
            );
        }
        if (request.method === "POST" && (issueList || reply)) {
            if (state.hangPosts) return;
            const comment: FakeComment = {
                id: state.nextId++,
                kind: issueList ? "issue" : "review",
                pull: Number((issueList ?? reply)?.[1]),
                body: (JSON.parse(body) as { body: string }).body,
                inReplyTo: reply ? Number(reply[2]) : null,
            };
            comments.push(comment);
            if (state.dropNextPostResponse) {
                state.dropNextPostResponse = false;
                request.socket.destroy();
                return;
            }
            return send(201, { id: comment.id });
        }
        send(404, {});
    });
    await new Promise<void>((resolve) =>
        server.listen(0, "127.0.0.1", resolve),
    );
    return {
        url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        comments,
        routes,
        tokenRequests,
        reviewParents,
        states,
        state,
        close: () =>
            new Promise<void>((resolve) => {
                server.closeAllConnections();
                server.close(() => resolve());
            }),
    };
};
export type FakeGitHub = Awaited<ReturnType<typeof fakeGitHub>>;

export const privateKey = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
}).privateKey;

export const tempDirectory = async () => {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "gh-bot-")));
    await mkdir(join(directory, "state"), { mode: 0o700 });
    await mkdir(join(directory, "workspaces"), { mode: 0o700 });
    return {
        path: directory,
        [Symbol.asyncDispose]: () =>
            rm(directory, { recursive: true, force: true }),
    };
};

const fixtureProvider = {
    providers: {
        fixture: {
            package: "aisdk:@ai-sdk/openai-compatible",
            settings: { baseURL: "https://provider.invalid/v1" },
            models: { "fixture-chat": {} },
        },
    },
};

/** The production service graph with a scripted model and fake GitHub. */
export const botLayer = (
    directory: string,
    github: FakeGitHub,
    llm: TestLLM.TestInterface,
    options: { readonly gitUrl?: string } = {},
) => {
    const socket = (id: string) => join(directory, "run", `${id}.sock`);
    const checkout = options.gitUrl
        ? makeCheckout({
              gitUrl: options.gitUrl,
              mirrorDirectory: join(directory, "state", "mirrors"),
              socket,
          })
        : () => Effect.void;
    const core = Layer.mergeAll(
        Repository.layer(join(directory, "state", "bot.sqlite")),
        GitHub.layer({ apiUrl: github.url, appId: 1, privateKey }),
        AgentHost.layer({
            stateDirectory: join(directory, "state"),
            model: "fixture/fixture-chat",
            systemPrompt: "Fixture assistant.",
            config: fixtureProvider,
            embed: {
                overrides: [
                    llmClient.replace(Layer.succeed(LLMClient.Service, llm)),
                ],
            },
            workspaces: {
                socket,
                directory: (id) => join(directory, "workspaces", id),
            },
        }),
    );
    // Each conversation gets a real workspace executor on its own socket.
    // Linux-user isolation is provided by systemd in deployment.
    const conversations = Layer.unwrap(
        Effect.gen(function* () {
            const scope = yield* Effect.scope;
            const started = new Set<string>();
            const startWorkspace = (id: string) =>
                Effect.gen(function* () {
                    const root = join(directory, "workspaces", id);
                    yield* Effect.promise(async () => {
                        await mkdir(root, { recursive: true });
                        await mkdir(join(directory, "run"), {
                            recursive: true,
                        });
                    });
                    yield* serveWorkspace({
                        root,
                        listen: { path: socket(id) },
                    }).pipe(Scope.provide(scope));
                    started.add(id);
                });
            return Conversations.layer({
                bot: BOT,
                maxConcurrentTurns: 2,
                sweepInterval: "200 millis",
                prepareWorkspace: (conversation) =>
                    (started.has(conversation.workspaceId)
                        ? Effect.void
                        : startWorkspace(conversation.workspaceId)
                    ).pipe(Effect.andThen(checkout(conversation))),
            });
        }),
    );
    return conversations.pipe(
        Layer.provideMerge(
            Layer.succeed(WebhookSettings, { secret: SECRET, bot: BOT }),
        ),
        Layer.provideMerge(core),
    );
};

/** Responds to every main-agent request with a reply naming the prompt. */
export const echoModel = (llm: TestLLM.TestInterface) =>
    llm.serve((request) => {
        const markers = [
            ...JSON.stringify(request.messages).matchAll(
                /comment-marker-(\w+)/g,
            ),
        ];
        return TestLLM.text(
            `reply to ${markers.at(-1)?.[1] ?? "nothing"}`,
            "t",
        );
    });

export type BotServices =
    | Repository
    | WebhookSettings
    | Conversations.Conversations;

/** Runs one bot process lifetime over persistent state in `directory`. */
export const runBot = <A, E>(
    directory: string,
    github: FakeGitHub,
    body: (llm: TestLLM.TestInterface) => Effect.Effect<A, E, BotServices>,
    model: (llm: TestLLM.TestInterface) => Effect.Effect<void> = echoModel,
    options: { readonly gitUrl?: string } = {},
) =>
    Effect.runPromise(
        Effect.gen(function* () {
            const llm = yield* TestLLM.Test;
            yield* model(llm);
            return yield* body(llm).pipe(
                Effect.provide(botLayer(directory, github, llm, options)),
            );
        }).pipe(Effect.provide(TestLLM.testLayer()), Effect.scoped),
    );

export const send = (input: WebhookInput) => acceptWebhook(input);

export const eventually = <A>(check: () => A | undefined | false) =>
    Effect.suspend(() => {
        const value = check();
        return value ? Effect.succeed(value) : Effect.fail("not yet" as const);
    }).pipe(
        Effect.retry(Schedule.spaced("25 millis")),
        Effect.timeout("10 seconds"),
    );
