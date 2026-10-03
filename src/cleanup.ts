import { join } from "node:path";
import { NodeRuntime } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { configFromEnvironment, readPrivateFile } from "./config";
import {
    CLOSED_RETENTION_MS,
    cleanupClosedWorkspaces,
} from "./conversations/cleanup";
import { Repository } from "./conversations/repository";
import { GitHub } from "./github/client";
import { requestWorkspaceDeletion } from "./workspace/provision";

/**
 * One-shot cleanup run daily by `opencode-github-bot-cleanup.timer`. Deletes
 * workspaces of pull requests closed for over seven days; the running bot
 * interrupts any turn still using one.
 */
const cleanup = Effect.gen(function* () {
    const config = yield* configFromEnvironment(process.env);
    const privateKey = yield* readPrivateFile(config.github.privateKeyPath);
    const deleted = yield* cleanupClosedWorkspaces({
        closedForMs: CLOSED_RETENTION_MS,
        requestDeletion: (workspaceId) =>
            requestWorkspaceDeletion(
                {
                    socketDirectory: config.workspaceSocketDirectory,
                    requestDirectory: join(
                        config.stateDirectory,
                        "workspace-requests",
                    ),
                },
                workspaceId,
            ),
    }).pipe(
        Effect.provide(
            Layer.mergeAll(
                Repository.layer(join(config.stateDirectory, "bot.sqlite")),
                GitHub.layer({
                    apiUrl: config.github.apiUrl,
                    appId: config.github.appId,
                    privateKey,
                }),
            ),
        ),
    );
    yield* Effect.logInfo("workspace cleanup finished", {
        deletedWorkspaces: deleted.length,
    });
});

cleanup.pipe(NodeRuntime.runMain);
