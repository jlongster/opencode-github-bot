import { Effect, Exit } from "effect";
import { expect, it } from "vitest";
import { configFromEnvironment } from "../src/config";

const environment = {
    GITHUB_BOT_PUBLIC_ORIGIN: "https://bot.example.com",
    GITHUB_APP_ID: "1",
    GITHUB_APP_SLUG: "bot",
    GITHUB_APP_PRIVATE_KEY_PATH: "/etc/bot/app.pem",
    GITHUB_WEBHOOK_SECRET_PATH: "/etc/bot/webhook-secret",
    GITHUB_ALLOWED_INSTALLATIONS: "11",
    OPENCODE_MODEL: "opencode/model",
    GITHUB_BOT_STATE_DIRECTORY: "/var/lib/bot",
};

it("requires a non-empty user allowlist of numeric IDs", async () => {
    const load = (users: string | undefined) =>
        Effect.runPromiseExit(
            configFromEnvironment({
                ...environment,
                ...(users === undefined ? {} : { GITHUB_ALLOWED_USERS: users }),
            }),
        );
    expect(Exit.isFailure(await load(undefined))).toBe(true);
    expect(Exit.isFailure(await load(""))).toBe(true);
    expect(Exit.isFailure(await load("jlongster"))).toBe(true);
    const loaded = await load("17031, 42");
    expect(Exit.isSuccess(loaded) && loaded.value.github.allowedUsers).toEqual([
        17031, 42,
    ]);
});
