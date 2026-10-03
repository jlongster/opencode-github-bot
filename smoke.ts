import { generateKeyPairSync } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Starts the production bundle with synthetic configuration and checks health. */
const directory = await realpath(
    await mkdtemp(join(tmpdir(), "gh-bot-smoke-")),
);
const port = 20_000 + Math.floor(Math.random() * 20_000);
try {
    for (const name of ["secrets", "state", "workspaces"])
        await mkdir(join(directory, name), { mode: 0o700 });
    await writeFile(join(directory, "secrets", "webhook"), "smoke-secret", {
        mode: 0o600,
    });
    await writeFile(
        join(directory, "secrets", "app.pem"),
        generateKeyPairSync("rsa", {
            modulusLength: 2048,
            privateKeyEncoding: { type: "pkcs8", format: "pem" },
            publicKeyEncoding: { type: "spki", format: "pem" },
        }).privateKey,
        { mode: 0o600 },
    );
    const child = Bun.spawn(["node", "dist/main.mjs"], {
        cwd: import.meta.dir,
        env: {
            PATH: process.env.PATH ?? "/usr/bin:/bin",
            HOME: directory,
            GITHUB_BOT_LISTEN_PORT: String(port),
            GITHUB_BOT_PUBLIC_ORIGIN: "https://bot.invalid",
            GITHUB_APP_ID: "1",
            GITHUB_APP_SLUG: "smoke-bot",
            GITHUB_APP_PRIVATE_KEY_PATH: join(directory, "secrets", "app.pem"),
            GITHUB_WEBHOOK_SECRET_PATH: join(directory, "secrets", "webhook"),
            GITHUB_ALLOWED_INSTALLATIONS: "1",
            GITHUB_ALLOWED_USERS: "1",
            GITHUB_API_URL: "http://127.0.0.1:9",
            OPENCODE_MODEL: "opencode/smoke",
            GITHUB_BOT_STATE_DIRECTORY: join(directory, "state"),
            GITHUB_BOT_WORKSPACE_SOCKETS: join(directory, "workspaces"),
        },
        stdout: "inherit",
        stderr: "inherit",
    });
    try {
        let healthy = false;
        for (let attempt = 0; attempt < 100 && !healthy; attempt++) {
            await Bun.sleep(200);
            healthy = await fetch(`http://127.0.0.1:${port}/health`)
                .then((response) => response.ok)
                .catch(() => false);
        }
        if (!healthy)
            throw new Error("production bundle did not become healthy");
        console.log("Production smoke passed.");
    } finally {
        child.kill();
        await child.exited;
    }
} finally {
    await rm(directory, { recursive: true, force: true });
}
