import { spawn } from "node:child_process";
import { chmod, unlink } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { isAbsolute } from "node:path";
import { Effect, Schema, type Scope } from "effect";
import {
    chunks,
    encodeFrame,
    forwardableEnv,
    frameReader,
    MAX_CHUNK_BYTES,
    PROTOCOL_VERSION,
    ProcessCommand,
    type ProcessEvent,
    ProcessStart,
} from "./protocol";

export type WorkspaceServerOptions = {
    /** Directory processes start in by default; the model sees it as its workspace. */
    readonly root: string;
    /** Listen on a path, or adopt a systemd-activated listener (fd 3). */
    readonly listen: { readonly path: string } | { readonly fd: number };
    readonly maxProcesses?: number;
};

const decodeStart = Schema.decodeUnknownSync(ProcessStart);
const decodeCommand = Schema.decodeUnknownSync(ProcessCommand);

/** Serves exactly one process on a connection, then closes it. */
const handleConnection = (socket: Socket, options: WorkspaceServerOptions) => {
    let started: ReturnType<typeof spawn> | undefined;
    let id = "";
    const send = (event: ProcessEvent["event"]) =>
        new Promise<void>((resolve) => {
            if (socket.destroyed) return resolve();
            socket.write(
                encodeFrame({ version: PROTOCOL_VERSION, id, event }),
                () => resolve(),
            );
        });
    const fail = (message: string) => {
        void send({ type: "error", message }).then(() => socket.destroy());
        if (started?.pid) killGroup(started.pid, "SIGKILL");
    };

    const start = (raw: unknown) => {
        const request = decodeStart(raw);
        id = request.id;
        const cwd = request.cwd ?? options.root;
        if (!isAbsolute(cwd)) return fail("cwd must be absolute");
        const child = spawn(request.command, [...request.args], {
            cwd,
            detached: true,
            shell: false,
            stdio: ["pipe", "pipe", "pipe"],
            env: {
                HOME: options.root,
                LANG: process.env.LANG ?? "C.UTF-8",
                PATH: process.env.PATH ?? "/usr/local/bin:/usr/bin:/bin",
                ...forwardableEnv(request.env),
            },
        });
        started = child;
        // Output is forwarded in order; the exit event waits for all of it.
        let writes = Promise.resolve();
        const forward = (type: "stdout" | "stderr") => (chunk: Buffer) => {
            const stream = child[type];
            stream?.pause();
            writes = writes
                .then(async () => {
                    for (const dataBase64 of chunks(chunk))
                        await send({ type, dataBase64 });
                })
                .then(() => {
                    stream?.resume();
                });
        };
        child.stdout?.on("data", forward("stdout"));
        child.stderr?.on("data", forward("stderr"));
        child.once("spawn", () => {
            writes = writes.then(() =>
                send({ type: "started", pid: child.pid ?? 0 }),
            );
        });
        child.once("error", () => fail("spawn failed"));
        child.once("close", (exitCode, signal) => {
            void writes
                .then(() => send({ type: "exited", exitCode, signal }))
                .then(() => socket.end());
        });
    };

    const command = (raw: unknown) => {
        const message = decodeCommand(raw);
        const child = started;
        if (!child || message.id !== id) return fail("protocol");
        const value = message.command;
        if (value.type === "stdin") {
            const bytes = Buffer.from(value.dataBase64, "base64");
            if (bytes.length > MAX_CHUNK_BYTES) return fail("protocol");
            if (!child.stdin?.write(bytes)) {
                socket.pause();
                child.stdin?.once("drain", () => socket.resume());
            }
        } else if (value.type === "stdin.end") child.stdin?.end();
        else if (child.pid) killGroup(child.pid, value.signal);
    };

    const read = frameReader((frame) => {
        try {
            const raw: unknown = JSON.parse(frame.toString("utf8"));
            if (started) command(raw);
            else start(raw);
        } catch {
            fail("protocol");
        }
    });
    socket.on("data", (chunk: Buffer) => {
        if (!read(chunk)) fail("protocol");
    });
    socket.on("error", () => socket.destroy());
    socket.once("close", () => {
        if (
            started?.pid &&
            started.exitCode === null &&
            started.signalCode === null
        )
            killGroup(started.pid, "SIGKILL");
    });
};

const killGroup = (pid: number, signal: NodeJS.Signals) => {
    try {
        process.kill(-pid, signal);
    } catch {}
};

const listen = (server: Server, options: WorkspaceServerOptions) =>
    Effect.callback<void, Error>((resume) => {
        server.once("error", (error) => resume(Effect.fail(error)));
        const ready = () => resume(Effect.void);
        if ("fd" in options.listen)
            server.listen({ fd: options.listen.fd }, ready);
        else server.listen(options.listen.path, ready);
    });

export const serveWorkspace = (
    options: WorkspaceServerOptions,
): Effect.Effect<void, Error, Scope.Scope> =>
    Effect.gen(function* () {
        const sockets = new Set<Socket>();
        const server = createServer((socket) => {
            if (sockets.size >= (options.maxProcesses ?? 32)) {
                socket.destroy();
                return;
            }
            sockets.add(socket);
            socket.once("close", () => sockets.delete(socket));
            handleConnection(socket, options);
        });
        yield* Effect.acquireRelease(listen(server, options), () =>
            Effect.promise(async () => {
                for (const socket of sockets) socket.destroy();
                await new Promise<void>((resolve) =>
                    server.close(() => resolve()),
                );
                if ("path" in options.listen)
                    await unlink(options.listen.path).catch(() => undefined);
            }),
        );
        if ("path" in options.listen) {
            const path = options.listen.path;
            yield* Effect.tryPromise({
                try: () => chmod(path, 0o600),
                catch: (cause) => new Error("chmod failed", { cause }),
            });
        }
    });
