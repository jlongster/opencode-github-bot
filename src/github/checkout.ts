import { spawn } from "node:child_process";
import { access, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { Effect, Schema, Semaphore, Stream } from "effect";
import * as ChildProcess from "effect/unstable/process/ChildProcess";
import { makeWorkspaceSpawner } from "../agent/workspace-driver";
import type { ConversationRow } from "../conversations/repository";
import { MAX_CHUNK_BYTES } from "../workspace/protocol";
import { GitHub } from "./client";

export class CheckoutError extends Schema.TaggedError<CheckoutError>()(
    "CheckoutError",
    { message: Schema.String },
) {}

export type CheckoutOptions = {
    /** Base for clone URLs, e.g. `https://github.com`. */
    readonly gitUrl: string;
    /** Control-owned directory of per-repository bare mirrors. */
    readonly mirrorDirectory: string;
    readonly socket: (workspaceId: string) => string;
};

const MAX_BUNDLE_BYTES = 512 * 1024 * 1024;

/** Runs git in the control process; credentials only ever appear in its environment. */
const git = (
    args: ReadonlyArray<string>,
    token: string | undefined,
    maxOutput = 0,
) =>
    Effect.callback<Buffer, CheckoutError>((resume) => {
        const child = spawn("git", [...args], {
            stdio: ["ignore", "pipe", "pipe"],
            env: {
                PATH: process.env.PATH ?? "/usr/bin:/bin",
                GIT_TERMINAL_PROMPT: "0",
                GIT_CONFIG_NOSYSTEM: "1",
                GIT_CONFIG_GLOBAL: "/dev/null",
                ...(token
                    ? {
                          GIT_CONFIG_COUNT: "1",
                          GIT_CONFIG_KEY_0: "http.extraHeader",
                          GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(
                              `x-access-token:${token}`,
                          ).toString("base64")}`,
                      }
                    : {}),
            },
        });
        const output: Buffer[] = [];
        let bytes = 0;
        child.stdout.on("data", (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxOutput) child.kill("SIGKILL");
            else output.push(chunk);
        });
        child.stderr.resume();
        child.once("error", () =>
            resume(
                Effect.fail(new CheckoutError({ message: "git unavailable" })),
            ),
        );
        child.once("close", (code) =>
            resume(
                code === 0
                    ? Effect.succeed(Buffer.concat(output))
                    : Effect.fail(
                          new CheckoutError({
                              message: `git ${args[2] ?? ""} failed`,
                          }),
                      ),
            ),
        );
        return Effect.sync(() => child.kill("SIGKILL"));
    });

/**
 * Fetches the bundle into the workspace as the workspace's own user:
 * `sh -c SCRIPT sh <branch> <start-ref> <refspec>...`. The branch is created
 * from the start ref only the first time; later imports just refresh refs.
 */
const WORKSPACE_SCRIPT = `set -eu
branch=$1
start=$2
shift 2
mkdir -p repo
cd repo
fresh=0
if [ ! -d .git ]; then git init -q; fresh=1; fi
cat > .git/incoming.bundle
git fetch -q --force .git/incoming.bundle "$@"
rm -f .git/incoming.bundle
if [ "$fresh" = 1 ]; then git checkout -q -b "$branch" "$start"; fi`;

type Plan = {
    /** Refs fetched into the control-owned mirror and bundled. */
    readonly refs: ReadonlyArray<string>;
    /** Bundle ref to workspace ref mappings. */
    readonly refspecs: ReadonlyArray<string>;
    readonly branch: string;
    readonly start: string;
};

const importBundle = (socket: string, plan: Plan, bundle: Buffer) =>
    Effect.gen(function* () {
        const chunks = Array.from(
            { length: Math.ceil(bundle.length / MAX_CHUNK_BYTES) },
            (_, i) =>
                Uint8Array.from(
                    bundle.subarray(
                        i * MAX_CHUNK_BYTES,
                        (i + 1) * MAX_CHUNK_BYTES,
                    ),
                ),
        );
        const handle = yield* makeWorkspaceSpawner(socket).spawn(
            ChildProcess.make(
                "sh",
                [
                    "-c",
                    WORKSPACE_SCRIPT,
                    "sh",
                    plan.branch,
                    plan.start,
                    ...plan.refspecs,
                ],
                { stdin: Stream.fromIterable(chunks) },
            ),
        );
        yield* Effect.all(
            [Stream.runDrain(handle.stdout), Stream.runDrain(handle.stderr)],
            { concurrency: "unbounded" },
        );
        return yield* handle.exitCode;
    }).pipe(
        Effect.scoped,
        Effect.mapError(
            () => new CheckoutError({ message: "workspace import failed" }),
        ),
        Effect.filterOrFail(
            (code) => code === 0,
            () => new CheckoutError({ message: "workspace import failed" }),
        ),
    );

/**
 * Refreshes the conversation's `/workspace/repo`: `pr/head` and `pr/base` for
 * a pull request (branch `pr-<n>`), or `default` for an issue (branch
 * `issue-<n>`). The branch is checked out the first time; existing work is
 * never reset.
 */
export const makeCheckout = (options: CheckoutOptions) => {
    const locks = new Map<number, Semaphore.Semaphore>();
    const lock = (repositoryId: number) => {
        let semaphore = locks.get(repositoryId);
        if (!semaphore) {
            semaphore = Semaphore.makeUnsafe(1);
            locks.set(repositoryId, semaphore);
        }
        return semaphore;
    };

    return (conversation: ConversationRow) =>
        Effect.gen(function* () {
            const github = yield* GitHub;
            const plan: Plan =
                conversation.target === "pull"
                    ? yield* github
                          .pullRequest(conversation, conversation.number)
                          .pipe(
                              Effect.map(({ baseRef }) => ({
                                  refs: [
                                      `refs/pull/${conversation.number}/head`,
                                      `refs/heads/${baseRef}`,
                                  ],
                                  refspecs: [
                                      `+refs/pull/${conversation.number}/head:refs/remotes/pr/head`,
                                      `+refs/heads/${baseRef}:refs/remotes/pr/base`,
                                  ],
                                  branch: `pr-${conversation.number}`,
                                  start: "refs/remotes/pr/head",
                              })),
                          )
                    : yield* github.defaultBranch(conversation).pipe(
                          Effect.map((branch) => ({
                              refs: [`refs/heads/${branch}`],
                              refspecs: [
                                  `+refs/heads/${branch}:refs/remotes/default`,
                              ],
                              branch: `issue-${conversation.number}`,
                              start: "refs/remotes/default",
                          })),
                      );
            const token = yield* github.installationToken(conversation);
            const mirror = join(
                options.mirrorDirectory,
                `${conversation.repositoryId}.git`,
            );
            const bundle = yield* lock(conversation.repositoryId).withPermit(
                Effect.gen(function* () {
                    const exists = yield* Effect.promise(() =>
                        access(mirror).then(
                            () => true,
                            () => false,
                        ),
                    );
                    if (!exists) {
                        yield* Effect.promise(() =>
                            mkdir(options.mirrorDirectory, {
                                recursive: true,
                                mode: 0o700,
                            }),
                        );
                        yield* git(["init", "--bare", "-q", mirror], undefined);
                    }
                    yield* git(
                        [
                            "-C",
                            mirror,
                            "fetch",
                            "-q",
                            "--force",
                            "--no-tags",
                            `${options.gitUrl}/${conversation.repository}.git`,
                            ...plan.refs.map((ref) => `+${ref}:${ref}`),
                        ],
                        token,
                    );
                    return yield* git(
                        [
                            "-C",
                            mirror,
                            "bundle",
                            "create",
                            "-q",
                            "-",
                            ...plan.refs,
                        ],
                        undefined,
                        MAX_BUNDLE_BYTES,
                    );
                }),
            );
            yield* importBundle(
                options.socket(conversation.workspaceId),
                plan,
                bundle,
            );
        });
};
