import { randomUUID } from "node:crypto";
import { connect, type Socket } from "node:net";
import type { EnvironmentDriver } from "@opencode/core/environment/driver";
import { WorkspaceDriver } from "@opencode/core/workspace/driver";
import {
    type Cause,
    Deferred,
    Effect,
    Queue,
    Ref,
    Schema,
    Sink,
    Stream,
} from "effect";
import * as PlatformError from "effect/PlatformError";
import type { Command } from "effect/unstable/process/ChildProcess";
import * as ChildProcessSpawner from "effect/unstable/process/ChildProcessSpawner";
import {
    chunks,
    encodeFrame,
    forwardableEnv,
    frameReader,
    PROTOCOL_VERSION,
    ProcessEvent,
} from "../workspace/protocol";

const unavailable = (method: string, cause?: unknown) =>
    PlatformError.systemError({
        _tag: "Unknown",
        module: "Workspace",
        method,
        description: "The conversation workspace is unavailable.",
        ...(cause === undefined ? {} : { cause }),
    });

const openSocket = (path: string) =>
    Effect.callback<Socket, PlatformError.PlatformError>((resume) => {
        const socket = connect(path);
        const onConnect = () => {
            socket.off("error", onError);
            resume(Effect.succeed(socket));
        };
        const onError = (cause: unknown) => {
            socket.off("connect", onConnect);
            socket.destroy();
            resume(Effect.fail(unavailable("connect", cause)));
        };
        socket.once("connect", onConnect);
        socket.once("error", onError);
        return Effect.sync(() => socket.destroy());
    });

const write = (socket: Socket, value: unknown) =>
    Effect.callback<void, PlatformError.PlatformError>((resume) => {
        if (socket.destroyed) return resume(Effect.fail(unavailable("write")));
        socket.write(encodeFrame(value), (error) =>
            resume(
                error ? Effect.fail(unavailable("write", error)) : Effect.void,
            ),
        );
    });

const decodeEvent = Schema.decodeUnknownSync(ProcessEvent);

/** Runs OpenCode's processes (and process-backed file tools) in the workspace. */
export const makeWorkspaceSpawner = (socketPath: string) =>
    ChildProcessSpawner.make((command: Command) =>
        Effect.gen(function* () {
            if (command._tag !== "StandardCommand")
                return yield* unavailable("spawn");
            const id = randomUUID();
            const socket = yield* Effect.acquireRelease(
                openSocket(socketPath),
                (s) => Effect.sync(() => s.destroy()),
            );
            const started = yield* Deferred.make<
                ChildProcessSpawner.ProcessId,
                PlatformError.PlatformError
            >();
            const exited = yield* Deferred.make<
                ChildProcessSpawner.ExitCode,
                PlatformError.PlatformError
            >();
            const running = yield* Ref.make(true);
            const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
            const stderr = yield* Queue.unbounded<Uint8Array, Cause.Done>();

            let terminal = false;
            const finish = (
                exit: Effect.Effect<
                    ChildProcessSpawner.ExitCode,
                    PlatformError.PlatformError
                >,
            ) => {
                if (terminal) return;
                terminal = true;
                Deferred.doneUnsafe(started, Effect.fail(unavailable("spawn")));
                Deferred.doneUnsafe(exited, exit);
                Queue.endUnsafe(stdout);
                Queue.endUnsafe(stderr);
                Effect.runFork(Ref.set(running, false));
            };
            const fail = (method: string, cause?: unknown) => {
                finish(Effect.fail(unavailable(method, cause)));
                socket.destroy();
            };
            const read = frameReader((frame) => {
                try {
                    const message = decodeEvent(
                        JSON.parse(frame.toString("utf8")),
                    );
                    if (message.id !== id) return fail("protocol");
                    const event = message.event;
                    if (event.type === "started")
                        Deferred.doneUnsafe(
                            started,
                            Effect.succeed(
                                ChildProcessSpawner.ProcessId(event.pid),
                            ),
                        );
                    else if (event.type === "stdout" || event.type === "stderr")
                        Queue.offerUnsafe(
                            event.type === "stdout" ? stdout : stderr,
                            Uint8Array.from(
                                Buffer.from(event.dataBase64, "base64"),
                            ),
                        );
                    else if (event.type === "error")
                        fail("spawn", event.message);
                    else
                        finish(
                            event.exitCode === null
                                ? Effect.fail(unavailable("exitCode"))
                                : Effect.succeed(
                                      ChildProcessSpawner.ExitCode(
                                          event.exitCode,
                                      ),
                                  ),
                        );
                } catch (cause) {
                    fail("protocol", cause);
                }
            });
            const onData = (chunk: Buffer) => {
                if (!read(chunk)) fail("protocol");
            };
            const onClose = () => fail("connection");
            yield* Effect.acquireRelease(
                Effect.sync(() => {
                    socket.on("data", onData);
                    socket.once("close", onClose);
                    socket.once("error", onClose);
                }),
                () =>
                    Effect.sync(() => {
                        socket.off("data", onData);
                        socket.off("close", onClose);
                        socket.off("error", onClose);
                    }),
            );

            const env = forwardableEnv(command.options.env);
            yield* write(socket, {
                version: PROTOCOL_VERSION,
                id,
                command: command.command,
                args: [...command.args],
                ...(command.options.cwd ? { cwd: command.options.cwd } : {}),
                ...(Object.keys(env).length > 0 ? { env } : {}),
            });
            const pid = yield* Deferred.await(started);
            const send = (value: unknown) =>
                write(socket, {
                    version: PROTOCOL_VERSION,
                    id,
                    command: value,
                });

            // biome-ignore lint/suspicious/useIterableCallbackReturn: Sink callbacks return an Effect.
            const stdin = Sink.forEach((chunk: Uint8Array) =>
                Effect.forEach(
                    chunks(chunk),
                    (dataBase64) => send({ type: "stdin", dataBase64 }),
                    {
                        discard: true,
                    },
                ),
            ).pipe(
                Sink.ensuring(send({ type: "stdin.end" }).pipe(Effect.ignore)),
            );
            const out = Stream.fromQueue(stdout);
            const err = Stream.fromQueue(stderr);
            const handle = ChildProcessSpawner.makeHandle({
                pid,
                exitCode: Deferred.await(exited),
                isRunning: Ref.get(running),
                kill: (options) =>
                    send({
                        type: "kill",
                        signal: options?.killSignal ?? "SIGTERM",
                    }),
                stdin,
                stdout: out,
                stderr: err,
                all: Stream.merge(out, err),
                getInputFd: () => Sink.drain,
                getOutputFd: () => Stream.empty,
                unref: Effect.succeed(Effect.void),
            });

            const input = command.options.stdin;
            const stream = Stream.isStream(input)
                ? input
                : typeof input === "object" &&
                    input !== null &&
                    "stream" in input &&
                    Stream.isStream(input.stream)
                  ? input.stream
                  : undefined;
            if (stream)
                yield* Stream.run(stream, stdin).pipe(
                    Effect.catch(() => Effect.void),
                    Effect.forkScoped,
                );
            else if (
                input === "ignore" ||
                (typeof input === "object" &&
                    input !== null &&
                    "stream" in input &&
                    input.stream === "ignore")
            )
                yield* send({ type: "stdin.end" });
            return handle;
        }),
    );

/**
 * OpenCode workspace provider backed by per-conversation sockets. The socket
 * is derived from trusted routing state, never from model input.
 */
export const makeWorkspaceProvider = (
    socketFor: (workspaceID: string) => string | undefined,
) =>
    WorkspaceDriver.make({
        create: ({ workspaceID }) => {
            const socket = socketFor(workspaceID);
            return socket
                ? Effect.succeed({ binding: { socket } })
                : Effect.fail(
                      new WorkspaceDriver.Error({
                          message: "Unknown workspace.",
                      }),
                  );
        },
        connect: ({ workspaceID, binding }) =>
            typeof binding.socket === "string" &&
            binding.socket === socketFor(workspaceID)
                ? Effect.succeed({
                      spawner: makeWorkspaceSpawner(binding.socket),
                  } satisfies EnvironmentDriver.Driver)
                : Effect.fail(
                      new WorkspaceDriver.Error({
                          message: "Invalid workspace binding.",
                      }),
                  ),
        suspendForIdle: () => Effect.void,
        destroy: () => Effect.void,
    });
