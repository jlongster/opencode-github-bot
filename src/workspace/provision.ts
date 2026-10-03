import { access, open } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schedule, Schema } from "effect";

export class WorkspaceUnavailable extends Schema.TaggedError<WorkspaceUnavailable>()(
    "WorkspaceUnavailable",
    { message: Schema.String },
) {}

export type ProvisionOptions = {
    /** Directory of systemd-owned per-conversation sockets. */
    readonly socketDirectory: string;
    /** Queue watched by the root provisioning path unit. */
    readonly requestDirectory: string;
};

export const workspaceSocket = (socketDirectory: string, workspaceId: string) =>
    join(socketDirectory, `${workspaceId}.sock`);

const validId = (workspaceId: string) => /^[a-f0-9]{20}$/.test(workspaceId);

const exists = (path: string) =>
    Effect.promise(() =>
        access(path).then(
            () => true,
            () => false,
        ),
    );

/** Writes an owner-only request file; an existing identical request is fine. */
const writeRequest = (path: string) =>
    Effect.tryPromise({
        try: async () => {
            const handle = await open(path, "wx", 0o600);
            await handle.close();
        },
        catch: (error) => error,
    }).pipe(
        Effect.catch((error) =>
            (error as NodeJS.ErrnoException).code === "EEXIST"
                ? Effect.void
                : Effect.fail(
                      new WorkspaceUnavailable({
                          message: "request write failed",
                      }),
                  ),
        ),
    );

const waitFor = (ready: Effect.Effect<boolean>, message: string) =>
    ready.pipe(
        Effect.filterOrFail(
            (value) => value,
            () => new WorkspaceUnavailable({ message }),
        ),
        Effect.retry(Schedule.spaced("500 millis")),
        Effect.timeout("2 minutes"),
        Effect.mapError(() => new WorkspaceUnavailable({ message })),
    );

/**
 * Queues deletion of a workspace's Linux user, executor and directory. The
 * root provisioning unit processes deletions before creations.
 */
export const requestWorkspaceDeletion = (
    options: ProvisionOptions,
    workspaceId: string,
) =>
    validId(workspaceId)
        ? writeRequest(join(options.requestDirectory, `${workspaceId}.delete`))
        : Effect.fail(
              new WorkspaceUnavailable({ message: "invalid workspace id" }),
          );

/**
 * Ensures a conversation's workspace socket exists, requesting provisioning
 * (Linux user, private directory, socket-activated executor) when needed.
 */
export const ensureWorkspace = (
    options: ProvisionOptions,
    workspaceId: string,
) =>
    Effect.gen(function* () {
        if (!validId(workspaceId))
            return yield* new WorkspaceUnavailable({
                message: "invalid workspace id",
            });
        // A reopened pull request may race a pending deletion of its old workspace.
        yield* waitFor(
            exists(
                join(options.requestDirectory, `${workspaceId}.delete`),
            ).pipe(Effect.map((pending) => !pending)),
            "workspace deletion still pending",
        );
        const socket = workspaceSocket(options.socketDirectory, workspaceId);
        if (yield* exists(socket)) return;
        yield* writeRequest(
            join(options.requestDirectory, `${workspaceId}.request`),
        );
        yield* waitFor(exists(socket), "workspace provisioning timed out");
    });
