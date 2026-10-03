import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { isAbsolute, normalize } from "node:path";
import { Effect, Schema } from "effect";

export class ConfigError extends Schema.TaggedError<ConfigError>()(
    "ConfigError",
    { message: Schema.String },
) {}

const AbsolutePath = Schema.String.check(
    Schema.makeFilter(
        (value) =>
            isAbsolute(value) &&
            normalize(value) === value &&
            value !== "/" &&
            !value.includes("\0"),
    ),
);

const HttpsOrigin = Schema.String.check(
    Schema.makeFilter((value) => {
        try {
            const url = new URL(value);
            return url.protocol === "https:" && url.origin === value;
        } catch {
            return false;
        }
    }),
);

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

export const Config = Schema.Struct({
    listen: Schema.Struct({
        host: Schema.Literals(["127.0.0.1", "::1", "0.0.0.0"]),
        port: Schema.Int.check(
            Schema.isBetween({ minimum: 0, maximum: 65_535 }),
        ),
    }),
    publicOrigin: HttpsOrigin,
    github: Schema.Struct({
        appId: PositiveInt,
        appSlug: Schema.String.check(
            Schema.isPattern(/^[a-z0-9][a-z0-9-]{0,98}$/),
        ),
        privateKeyPath: AbsolutePath,
        webhookSecretPath: AbsolutePath,
        apiUrl: Schema.String,
        gitUrl: Schema.String,
        allowedInstallations: Schema.Array(PositiveInt).check(
            Schema.isMinLength(1),
        ),
        /** Numeric GitHub user IDs (not logins, which can be reclaimed). */
        allowedUsers: Schema.Array(PositiveInt).check(Schema.isMinLength(1)),
    }),
    model: Schema.String.check(Schema.isPattern(/^[^/\s]+\/[^\s]+$/)),
    stateDirectory: AbsolutePath,
    workspaceSocketDirectory: AbsolutePath,
    maxConcurrentTurns: Schema.Int.check(
        Schema.isBetween({ minimum: 1, maximum: 32 }),
    ),
});
export type Config = typeof Config.Type;

const integer = (value: string | undefined) =>
    value !== undefined && /^\d{1,15}$/.test(value) ? Number(value) : value;

const idList = (value: string | undefined) =>
    (value ?? "")
        .split(",")
        .map((item) => item.trim())
        .filter(Boolean)
        .map(integer);

/** Reads only documented non-secret variables. Secrets live in private files. */
export const configFromEnvironment = (env: NodeJS.ProcessEnv) =>
    Schema.decodeUnknownEffect(Config, { onExcessProperty: "error" })({
        listen: {
            host: env.GITHUB_BOT_LISTEN_HOST ?? "127.0.0.1",
            port: integer(env.GITHUB_BOT_LISTEN_PORT ?? "8080"),
        },
        publicOrigin: env.GITHUB_BOT_PUBLIC_ORIGIN,
        github: {
            appId: integer(env.GITHUB_APP_ID),
            appSlug: env.GITHUB_APP_SLUG,
            privateKeyPath: env.GITHUB_APP_PRIVATE_KEY_PATH,
            webhookSecretPath: env.GITHUB_WEBHOOK_SECRET_PATH,
            apiUrl: env.GITHUB_API_URL ?? "https://api.github.com",
            gitUrl: env.GITHUB_GIT_URL ?? "https://github.com",
            allowedInstallations: idList(env.GITHUB_ALLOWED_INSTALLATIONS),
            allowedUsers: idList(env.GITHUB_ALLOWED_USERS),
        },
        model: env.OPENCODE_MODEL,
        stateDirectory: env.GITHUB_BOT_STATE_DIRECTORY,
        workspaceSocketDirectory:
            env.GITHUB_BOT_WORKSPACE_SOCKETS ??
            "/run/opencode-github-bot-workspaces",
        maxConcurrentTurns: integer(env.GITHUB_BOT_MAX_CONCURRENT_TURNS ?? "4"),
    }).pipe(
        Effect.mapError((error) => new ConfigError({ message: error.message })),
    );

/** Reads an owner-private (mode 0600, non-symlink) secret file. */
export const readPrivateFile = (path: string, maximumBytes = 64 * 1024) =>
    Effect.tryPromise({
        try: async () => {
            const info = await lstat(path);
            if (
                !info.isFile() ||
                (info.mode & 0o077) !== 0 ||
                (typeof process.getuid === "function" &&
                    info.uid !== process.getuid()) ||
                info.size > maximumBytes
            )
                throw new Error("unsafe secret file");
            const handle = await open(
                path,
                constants.O_RDONLY | constants.O_NOFOLLOW,
            );
            try {
                return (await handle.readFile("utf8")).trim();
            } finally {
                await handle.close();
            }
        },
        catch: () =>
            new ConfigError({ message: `secret file is unreadable: ${path}` }),
    });
