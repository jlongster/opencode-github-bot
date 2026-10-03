import { readFile, rm } from "node:fs/promises";
import { NodeRuntime } from "@effect/platform-node";
import { Integration, OpenCode } from "@opencode/sdk/effect";
import { Effect, Schema } from "effect";
import { readPrivateFile } from "../config";

/**
 * One-shot operator command, run as the service user while the bot is
 * stopped:
 *
 *     node dist/import-credential.mjs <state-directory> <credential-file>
 *
 * The file holds `{ integrationID, label, value }` in OpenCode's credential
 * format. It is installed through the public SDK credential API (replacing a
 * previous one with the same integration and label), activated, and deleted.
 * Prints only model IDs, never credential values.
 */
const Input = Schema.Struct({
    integrationID: Schema.String,
    label: Schema.String,
    value: Schema.Unknown,
});

const [stateDirectory, path] = process.argv.slice(2);

const program = Effect.gen(function* () {
    if (!stateDirectory || !path)
        return yield* Effect.fail(
            new Error("usage: import-credential <state-directory> <file>"),
        );
    yield* readPrivateFile(path, 64 * 1024);
    const input = yield* Effect.tryPromise(() => readFile(path, "utf8")).pipe(
        Effect.flatMap(
            Schema.decodeUnknownEffect(Schema.fromJsonString(Input)),
        ),
    );
    const sdk = yield* OpenCode.create({
        database: { path: `${stateDirectory}/opencode.sqlite` },
        config: { directory: stateDirectory, project: false },
        fs: { filewatcher: false },
    });
    const integrationID = Integration.ID.make(input.integrationID);
    for (const existing of yield* sdk.credential.list())
        if (
            existing.integrationID === integrationID &&
            existing.label === input.label
        )
            yield* sdk.credential.remove({ credentialID: existing.id });
    yield* sdk.credential.create({
        integrationID,
        label: input.label,
        value: input.value as never,
        activate: true,
    });
    yield* Effect.promise(() => rm(path, { force: true }));
    const models = yield* sdk.model.list();
    const ids = models.data
        .filter((model) => model.providerID === input.integrationID)
        .map((model) => `${model.providerID}/${model.id}`);
    process.stdout.write(
        `${JSON.stringify({ imported: true, models: ids })}\n`,
    );
}).pipe(Effect.scoped);

program.pipe(NodeRuntime.runMain);
