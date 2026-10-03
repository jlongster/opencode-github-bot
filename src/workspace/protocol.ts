import { Schema } from "effect";

/**
 * Length-prefixed JSON frames over a per-conversation Unix socket. One
 * connection carries exactly one process: a start frame, then stdin/kill
 * commands from the client and output/exit events from the server.
 */
export const PROTOCOL_VERSION = 1 as const;
export const MAX_FRAME_BYTES = 1024 * 1024;
export const MAX_CHUNK_BYTES = 64 * 1024;

const Id = Schema.String.check(Schema.isLengthBetween(1, 128));
const Chunk = Schema.String.check(
    Schema.isMaxLength(Math.ceil(MAX_CHUNK_BYTES / 3) * 4),
);

export const ProcessStart = Schema.Struct({
    version: Schema.Literal(PROTOCOL_VERSION),
    id: Id,
    command: Schema.String.check(Schema.isLengthBetween(1, 4096)),
    args: Schema.Array(Schema.String.check(Schema.isMaxLength(131_072))).check(
        Schema.isMaxLength(1024),
    ),
    cwd: Schema.optional(Schema.String.check(Schema.isLengthBetween(1, 4096))),
    env: Schema.optional(
        Schema.Record(
            Schema.String,
            Schema.String.check(Schema.isMaxLength(32_768)),
        ),
    ),
});
export type ProcessStart = typeof ProcessStart.Type;

export const ProcessCommand = Schema.Struct({
    version: Schema.Literal(PROTOCOL_VERSION),
    id: Id,
    command: Schema.Union([
        Schema.Struct({ type: Schema.Literal("stdin"), dataBase64: Chunk }),
        Schema.Struct({ type: Schema.Literal("stdin.end") }),
        Schema.Struct({
            type: Schema.Literal("kill"),
            signal: Schema.Literals(["SIGTERM", "SIGKILL", "SIGINT"]),
        }),
    ]),
});
export type ProcessCommand = typeof ProcessCommand.Type;

export const ProcessEvent = Schema.Struct({
    version: Schema.Literal(PROTOCOL_VERSION),
    id: Id,
    event: Schema.Union([
        Schema.Struct({ type: Schema.Literal("started"), pid: Schema.Int }),
        Schema.Struct({ type: Schema.Literal("stdout"), dataBase64: Chunk }),
        Schema.Struct({ type: Schema.Literal("stderr"), dataBase64: Chunk }),
        Schema.Struct({
            type: Schema.Literal("exited"),
            exitCode: Schema.NullOr(Schema.Int),
            signal: Schema.NullOr(Schema.String),
        }),
        Schema.Struct({
            type: Schema.Literal("error"),
            message: Schema.String,
        }),
    ]),
});
export type ProcessEvent = typeof ProcessEvent.Type;

/**
 * Environment variables a client may set on workspace processes. OpenCode
 * passes the host environment to some spawns; nothing else crosses over.
 */
export const forwardableEnv = (
    env: Readonly<Record<string, string | undefined>> | undefined,
): Record<string, string> =>
    Object.fromEntries(
        Object.entries(env ?? {}).filter(
            (entry): entry is [string, string] =>
                typeof entry[1] === "string" &&
                /^(LC_[A-Z]+|LANG|LANGUAGE|TERM|NO_COLOR|FORCE_COLOR|COLUMNS|LINES|GIT_PAGER|PAGER)$/.test(
                    entry[0],
                ),
        ),
    );

export const encodeFrame = (value: unknown) => {
    const payload = Buffer.from(JSON.stringify(value), "utf8");
    if (payload.length > MAX_FRAME_BYTES) throw new Error("frame too large");
    const frame = Buffer.allocUnsafe(payload.length + 4);
    frame.writeUInt32BE(payload.length, 0);
    payload.copy(frame, 4);
    return frame;
};

/** Incrementally splits a byte stream into frames; returns false on a protocol violation. */
export const frameReader = (onFrame: (frame: Buffer) => void) => {
    let buffer = Buffer.alloc(0);
    return (chunk: Buffer) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (buffer.length >= 4) {
            const length = buffer.readUInt32BE(0);
            if (length === 0 || length > MAX_FRAME_BYTES) return false;
            if (buffer.length < length + 4) break;
            const frame = buffer.subarray(4, length + 4);
            buffer = buffer.subarray(length + 4);
            onFrame(frame);
        }
        return true;
    };
};

/** Splits bytes into protocol-sized base64 chunks. */
export const chunks = (bytes: Uint8Array) => {
    const parts: string[] = [];
    for (let offset = 0; offset < bytes.length; offset += MAX_CHUNK_BYTES)
        parts.push(
            Buffer.from(
                bytes.subarray(offset, offset + MAX_CHUNK_BYTES),
            ).toString("base64"),
        );
    return parts;
};
