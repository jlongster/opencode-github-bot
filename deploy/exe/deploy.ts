#!/usr/bin/env bun
/**
 * Deploys the committed HEAD to an exe.dev VM:
 *
 *     bun deploy/exe/deploy.ts <ssh-destination>
 *
 * Uploads only `git archive HEAD` (no .git, ignored files, credentials or
 * state), builds it as the unprivileged `ghbot` user in a sandbox inside
 * /srv/opencode-github-bot/releases/<commit>, then atomically switches
 * `current`, restarts and health-checks the service, rolling back on failure.
 * Without /etc/opencode-github-bot/runtime.env the release is only staged.
 */
import { createHash } from "node:crypto";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { remoteScript } from "./release";

const destination = process.argv[2];
if (
    !destination ||
    process.argv.length !== 3 ||
    !/^[A-Za-z0-9@._-]+$/.test(destination)
) {
    console.error("usage: bun deploy/exe/deploy.ts <ssh-destination>");
    process.exit(2);
}

const run = (argv: string[], stdin?: string) => {
    const result = Bun.spawnSync(argv, {
        cwd: join(import.meta.dir, "../.."),
        stdin: stdin === undefined ? "ignore" : Buffer.from(stdin),
        stdout: "pipe",
        stderr: "inherit",
    });
    if (result.exitCode !== 0)
        throw new Error(`${argv[0]} exited with ${result.exitCode}`);
    return result.stdout.toString().trim();
};

if (run(["git", "status", "--porcelain", "--untracked-files=all"]) !== "") {
    console.error("refusing to deploy: the working tree is not clean");
    process.exit(1);
}
const commit = run(["git", "rev-parse", "HEAD"]);
if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("unexpected commit id");

const archive = join(tmpdir(), `opencode-github-bot-${commit}.tar`);
const upload = `/var/tmp/opencode-github-bot-${commit}.tar`;
const ssh = [
    "ssh",
    "-T",
    "-o",
    "BatchMode=yes",
    "-o",
    "StrictHostKeyChecking=yes",
];
try {
    run(["git", "archive", "--format=tar", `--output=${archive}`, commit]);
    const sha256 = createHash("sha256")
        .update(await readFile(archive))
        .digest("hex");
    run([
        "scp",
        "-q",
        "-o",
        "BatchMode=yes",
        archive,
        `${destination}:${upload}`,
    ]);
    const output = run(
        [...ssh, destination, "sudo", "timeout", "15m", "/bin/bash", "-s"],
        remoteScript(commit, sha256, upload),
    );
    console.log(output.split("\n").at(-1));
} finally {
    await rm(archive, { force: true });
}
