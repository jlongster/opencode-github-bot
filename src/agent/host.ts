import {
    AbsolutePath,
    OpenCode,
    Session,
    SessionMessage,
    Workspace,
} from "@opencode/sdk/effect";
import { Context, Effect, Layer, Option, Schema } from "effect";
import { makeWorkspaceProvider } from "./workspace-driver";

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
    message: Schema.String,
}) {}

export type TurnInput = {
    readonly sessionId: string;
    readonly conversationKey: string;
    /** Opaque conversation workspace ID (see `threads.workspaceId`). */
    readonly workspaceId: string;
    readonly messageId: string;
    readonly prompt: string;
};

export type TurnResult = {
    readonly outcome: "succeeded" | "failed";
    readonly text: string;
};

export type AgentHostOptions = {
    readonly stateDirectory: string;
    /** `provider/model`. */
    readonly model: string;
    readonly systemPrompt: string;
    readonly workspaces: {
        /** Control-side Unix socket of a conversation's workspace executor. */
        readonly socket: (workspaceId: string) => string;
        /** Working directory as seen inside that workspace. */
        readonly directory: (workspaceId: string) => string;
    };
    /** Extra SDK configuration, used by fixture providers in tests. */
    readonly config?: Record<string, unknown>;
    readonly embed?: OpenCode.EmbedOptions;
};

const AGENT = "github";
/**
 * Removed from the model's catalog. `question` would stall a turn (nobody can
 * answer on GitHub); `execute` (Code Mode), `webfetch` and `websearch` run in
 * the control process rather than the conversation workspace.
 */
const DISABLED_TOOLS = ["question", "execute", "webfetch", "websearch"];
const PROVIDER = "conversation";
const WORKSPACE_PREFIX = "wrk_";
const TURN_TIMEOUT = "30 minutes";
const MAX_RESUMES = 3;

export const DEFAULT_SYSTEM_PROMPT = `You are a GitHub assistant powered by OpenCode.
You receive comments on pull requests and issues and reply with a single Markdown comment.
Be concise and concrete. Reference files and lines when relevant.
Your tools run in this conversation's private, persistent workspace, where the
repository is checked out in \`repo/\` as described in each message. Your local
changes are kept between turns.
You cannot push commits, approve, merge, or change pull request or issue state.`;

type Message = SessionMessage.Info;

/**
 * Finds the outcome of the turn started by `messageId`: the assistant output
 * after that user message, closed by the next idle marker. Returns `None`
 * while the turn has not finished.
 */
export const turnResult = (
    messages: ReadonlyArray<Message>,
    messageId: string,
): Option.Option<TurnResult> => {
    const start = messages.findIndex((message) => message.id === messageId);
    if (start === -1) return Option.none();
    let text = "";
    for (const message of messages.slice(start + 1)) {
        if (message.type === "assistant") {
            const parts = message.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("")
                .trim();
            if (parts) text = parts;
        }
        if (message.type === "idle")
            return Option.some({
                outcome:
                    message.outcome === "succeeded" && text
                        ? "succeeded"
                        : "failed",
                text,
            });
        // Synthetic messages (e.g. restart notices) belong to the running turn.
        if (message.type === "user") return Option.none();
    }
    return Option.none();
};

export const makeAgentHost = Effect.fnUntraced(function* (
    options: AgentHostOptions,
) {
    const [providerID, ...rest] = options.model.split("/");
    const sdk = yield* OpenCode.create(
        {
            app: { name: "opencode-github-bot", version: "1" },
            database: { path: `${options.stateDirectory}/opencode.sqlite` },
            events: { persist: true },
            config: {
                directory: options.stateDirectory,
                project: false,
                content: JSON.stringify({
                    default_agent: AGENT,
                    model: `${providerID}/${rest.join("/")}`,
                    snapshots: false,
                    agents: {
                        [AGENT]: {
                            mode: "primary",
                            system: options.systemPrompt,
                            permissions: [
                                { action: "*", resource: "*", effect: "allow" },
                                ...DISABLED_TOOLS.map((action) => ({
                                    action,
                                    resource: "*",
                                    effect: "deny" as const,
                                })),
                            ],
                        },
                    },
                    ...options.config,
                }),
            },
            fs: { filewatcher: false },
            workspaceProviders: {
                [PROVIDER]: makeWorkspaceProvider((workspaceID) => {
                    const id = workspaceID.slice(WORKSPACE_PREFIX.length);
                    return workspaceID.startsWith(WORKSPACE_PREFIX) &&
                        /^[a-f0-9]{20}$/.test(id)
                        ? options.workspaces.socket(id)
                        : undefined;
                }),
            },
        },
        options.embed,
    ).pipe(
        Effect.mapError((error) => new AgentError({ message: String(error) })),
    );

    const stopped = new Set<string>();
    const unavailable = (reason: string) => () =>
        new AgentError({ message: reason });

    /** Reads messages newest-first until the turn's own user message is found. */
    const readTurn = (sessionID: Session.ID, messageId: string) =>
        Effect.gen(function* () {
            const collected: Message[] = [];
            let cursor: string | undefined;
            for (let page = 0; page < 20; page++) {
                const listed = yield* sdk.message.list({
                    sessionID,
                    order: "desc",
                    limit: 100,
                    ...(cursor === undefined ? {} : { cursor }),
                });
                collected.push(...listed.data);
                if (listed.data.some((message) => message.id === messageId))
                    break;
                cursor = listed.cursor.next;
                if (cursor === undefined) break;
            }
            return turnResult(collected.reverse(), messageId);
        }).pipe(Effect.mapError(unavailable("message-list")));

    const runTurn = (input: TurnInput) =>
        Effect.gen(function* () {
            const sessionID = Session.ID.make(input.sessionId);
            const messageID = SessionMessage.ID.make(input.messageId);
            const workspaceID = Workspace.ID.make(
                `${WORKSPACE_PREFIX}${input.workspaceId}`,
            );
            yield* sdk.workspace
                .create({ id: workspaceID, provider: PROVIDER })
                .pipe(Effect.mapError(unavailable("workspace-create")));
            yield* sdk.sessions
                .create({
                    id: sessionID,
                    title: input.conversationKey,
                    location: {
                        directory: AbsolutePath.make(
                            options.workspaces.directory(input.workspaceId),
                        ),
                        workspaceID,
                    },
                    metadata: { conversationKey: input.conversationKey },
                })
                .pipe(Effect.mapError(unavailable("session-create")));
            const admitted = yield* sdk.sessions.message
                .get({ sessionID, messageID })
                .pipe(Effect.option);
            if (Option.isNone(admitted))
                yield* sdk.sessions
                    .prompt({
                        sessionID,
                        id: messageID,
                        text: input.prompt,
                        delivery: "queue",
                        resume: true,
                    })
                    .pipe(Effect.mapError(unavailable("prompt")));
            for (let attempt = 0; attempt <= MAX_RESUMES; attempt++) {
                yield* sdk.sessions
                    .wait({ sessionID })
                    .pipe(Effect.mapError(unavailable("wait")));
                if (stopped.delete(input.sessionId))
                    return yield* new AgentError({ message: "interrupted" });
                const result = yield* readTurn(sessionID, input.messageId);
                if (Option.isSome(result)) return result.value;
                // Interrupted before completion (e.g. a restart): resume the
                // already-admitted message; its stable ID prevents duplication.
                yield* sdk.sessions
                    .prompt({
                        sessionID,
                        id: messageID,
                        text: input.prompt,
                        delivery: "queue",
                        resume: true,
                    })
                    .pipe(Effect.mapError(unavailable("resume")));
            }
            return yield* new AgentError({ message: "turn-incomplete" });
        }).pipe(
            Effect.timeoutOrElse({
                duration: TURN_TIMEOUT,
                orElse: () =>
                    Effect.fail(new AgentError({ message: "timeout" })),
            }),
        );

    /** Stops a running turn, which then fails instead of being resumed. */
    const interrupt = (sessionId: string) =>
        Effect.sync(() => stopped.add(sessionId)).pipe(
            Effect.andThen(
                sdk.sessions.interrupt({
                    sessionID: Session.ID.make(sessionId),
                    resume: false,
                }),
            ),
            Effect.asVoid,
            Effect.mapError(unavailable("interrupt")),
        );

    return { runTurn, interrupt };
});

export class AgentHost extends Context.Service<
    AgentHost,
    Effect.Success<ReturnType<typeof makeAgentHost>>
>()("opencode-github-bot/AgentHost") {
    static readonly layer = (options: AgentHostOptions) =>
        Layer.effect(AgentHost, makeAgentHost(options));
}
