import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { ConfigError, readPrivateFile } from "../config";
import { GitHub } from "../github/client";
import { collectFacts } from "./facts";

/**
 * Prints the triage facts for one issue or pull request:
 *
 *     TRIAGE_APP_ID=… TRIAGE_PRIVATE_KEY_PATH=… node dist/triage-facts.mjs owner/repo#123
 *
 * Read-only: it uses a token restricted to that repository.
 */
const collect = Effect.gen(function* () {
    const target = /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(process.argv[2] ?? "");
    const appId = Number(process.env.TRIAGE_APP_ID);
    const keyPath = process.env.TRIAGE_PRIVATE_KEY_PATH;
    const repository = target?.[1];
    const number = Number(target?.[2]);
    if (
        !repository ||
        !Number.isInteger(number) ||
        !Number.isInteger(appId) ||
        !keyPath
    )
        return yield* new ConfigError({
            message:
                "usage: TRIAGE_APP_ID=<id> TRIAGE_PRIVATE_KEY_PATH=<pem> triage-facts owner/repo#number",
        });
    const privateKey = yield* readPrivateFile(keyPath);
    const facts = yield* Effect.gen(function* () {
        const installationId = yield* (yield* GitHub).repositoryInstallation(
            repository,
        );
        return yield* collectFacts({ installationId, repository, number });
    }).pipe(
        Effect.provide(
            GitHub.layer({
                apiUrl: process.env.GITHUB_API_URL ?? "https://api.github.com",
                appId,
                privateKey,
            }),
        ),
    );
    process.stdout.write(`${JSON.stringify(facts, null, 2)}\n`);
});

collect.pipe(NodeRuntime.runMain);
