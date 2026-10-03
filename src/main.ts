import { createServer } from "node:http";
import { join } from "node:path";
import { NodeHttpServer, NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { AgentHost, DEFAULT_SYSTEM_PROMPT } from "./agent/host";
import { configFromEnvironment, readPrivateFile } from "./config";
import { Repository } from "./conversations/repository";
import * as Conversations from "./conversations/service";
import { makeCheckout } from "./github/checkout";
import { GitHub } from "./github/client";
import { serverLayer, WebhookSettings } from "./server";
import { ensureWorkspace, workspaceSocket } from "./workspace/provision";

const main = Effect.gen(function* () {
    const config = yield* configFromEnvironment(process.env);
    const secret = yield* readPrivateFile(config.github.webhookSecretPath);
    const privateKey = yield* readPrivateFile(config.github.privateKeyPath);
    const bot = {
        appSlug: config.github.appSlug,
        allowedInstallations: config.github.allowedInstallations,
        allowedUsers: config.github.allowedUsers,
    };

    const socket = (id: string) =>
        workspaceSocket(config.workspaceSocketDirectory, id);
    const checkout = makeCheckout({
        gitUrl: config.github.gitUrl,
        mirrorDirectory: join(config.stateDirectory, "mirrors"),
        socket,
    });

    const core = Layer.mergeAll(
        Repository.layer(join(config.stateDirectory, "bot.sqlite")),
        GitHub.layer({
            apiUrl: config.github.apiUrl,
            appId: config.github.appId,
            privateKey,
        }),
        AgentHost.layer({
            stateDirectory: config.stateDirectory,
            model: config.model,
            systemPrompt: DEFAULT_SYSTEM_PROMPT,
            workspaces: {
                socket,
                directory: () => "/workspace",
            },
        }),
    );
    const conversations = Conversations.layer({
        bot,
        maxConcurrentTurns: config.maxConcurrentTurns,
        prepareWorkspace: (conversation) =>
            ensureWorkspace(
                {
                    socketDirectory: config.workspaceSocketDirectory,
                    requestDirectory: join(
                        config.stateDirectory,
                        "workspace-requests",
                    ),
                },
                conversation.workspaceId,
            ).pipe(Effect.andThen(checkout(conversation))),
    });
    const http = serverLayer.pipe(
        Layer.provide(
            NodeHttpServer.layer(createServer, {
                host: config.listen.host,
                port: config.listen.port,
            }),
        ),
    );

    yield* Effect.logInfo("opencode-github-bot starting");
    return yield* Layer.launch(
        http.pipe(
            Layer.provideMerge(conversations),
            Layer.provideMerge(Layer.succeed(WebhookSettings, { secret, bot })),
            Layer.provideMerge(core),
        ),
    );
});

main.pipe(NodeRuntime.runMain);
