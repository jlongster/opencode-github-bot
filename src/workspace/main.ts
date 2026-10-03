import { NodeRuntime } from "@effect/platform-node";
import { Effect } from "effect";
import { serveWorkspace } from "./server";

/**
 * Per-conversation workspace executor. systemd runs one instance per
 * conversation as that conversation's Linux user and passes the listening
 * socket as fd 3; the control process is the only peer allowed to connect.
 */
const activated =
    process.env.LISTEN_PID === String(process.pid) &&
    process.env.LISTEN_FDS === "1";
const socketPath = process.env.WORKSPACE_SOCKET;

if (!activated && !socketPath) {
    process.stderr.write("workspace: no systemd socket or WORKSPACE_SOCKET\n");
    process.exit(1);
}

serveWorkspace({
    root: process.env.WORKSPACE_ROOT ?? "/workspace",
    listen: activated ? { fd: 3 } : { path: socketPath as string },
}).pipe(Effect.andThen(Effect.never), Effect.scoped, NodeRuntime.runMain);
