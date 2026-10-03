import {
    Cause,
    Context,
    type Duration,
    Effect,
    Layer,
    Queue,
    Schema,
    Semaphore,
} from "effect";
import { AgentHost } from "../agent/host";
import type { GitHub } from "../github/client";
import { deliverReply, replyBody } from "../github/delivery";
import { CommentEvent } from "../github/events";
import type { BotIdentity } from "../github/threads";
import { type ConversationRow, Repository } from "./repository";
import { routeEvent } from "./routing";

const SWEEP_INTERVAL: Duration.Input = "30 seconds";
const RECREATED_NOTE =
    "Note: this conversation's workspace was deleted after the pull request " +
    "closed and has been recreated with a fresh checkout. Any local changes " +
    "from earlier turns are gone.\n\n";
const FAILURE_REPLY =
    "Sorry, I couldn't complete a response to this comment. Please try again.";

export type ConversationsOptions = {
    readonly bot: BotIdentity;
    readonly maxConcurrentTurns: number;
    /** Ensures the conversation's persistent workspace exists and is reachable. */
    readonly prepareWorkspace: (
        conversation: ConversationRow,
    ) => Effect.Effect<void, unknown, GitHub>;
    readonly sweepInterval?: Duration.Input;
};

export class Conversations extends Context.Service<
    Conversations,
    {
        /** Signals that durable state changed; never carries work itself. */
        readonly wake: Effect.Effect<void>;
    }
>()("opencode-github-bot/Conversations") {}

/** Error tags and our own reason codes only; never payloads or provider text. */
const errorSummary = (error: unknown) =>
    typeof error === "object" && error !== null && "_tag" in error
        ? String(error._tag)
        : "unknown";
const causeSummary = (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
        ? "interrupted"
        : cause.reasons
              .map((reason) =>
                  reason._tag === "Fail"
                      ? errorSummary(reason.error)
                      : "defect",
              )
              .join(",");

const decodeEvent = Schema.decodeUnknownOption(
    Schema.fromJsonString(CommentEvent),
);

export const makeConversations = Effect.fnUntraced(function* (
    options: ConversationsOptions,
) {
    const repository = yield* Repository;
    const agent = yield* AgentHost;
    const context = yield* Effect.context<Repository | GitHub>();
    const scope = yield* Effect.scope;
    const signals = yield* Queue.sliding<void>(1);
    const permits = yield* Semaphore.make(options.maxConcurrentTurns);
    const running = new Set<string>();
    const wake = Queue.offer(signals, undefined).pipe(Effect.asVoid);

    repository.markInterruptedSubmissionsUnknown();

    /** Routes stored deliveries in arrival order; a failure leaves the rest for later. */
    const routeReceived = Effect.gen(function* () {
        for (const delivery of repository.receivedDeliveries()) {
            const event = decodeEvent(delivery.payload);
            if (event._tag === "None") {
                repository.routeDelivery(delivery.id, {
                    state: "ignored",
                    reason: "invalid-payload",
                });
                continue;
            }
            const outcome = yield* routeEvent(event.value, options.bot).pipe(
                Effect.tapError((error) =>
                    Effect.logWarning("routing deferred", {
                        delivery: delivery.id,
                        error: error._tag,
                    }),
                ),
                Effect.option,
            );
            if (outcome._tag === "None") return;
            repository.routeDelivery(delivery.id, outcome.value);
        }
    });

    const deliverOutbox = (key: string) =>
        Effect.gen(function* () {
            const conversation = repository.conversation(key);
            if (!conversation) return;
            for (const reply of repository.deliverableOutbox(key))
                yield* deliverReply(reply, conversation);
        });

    const runInbox = (key: string) =>
        Effect.gen(function* () {
            while (true) {
                const pending = repository.nextInbox(key);
                const known = repository.conversation(key);
                if (!pending || !known) return;
                // A new turn on a reopened pull request gets a fresh workspace;
                // tell the model its earlier local changes are gone.
                if (known.workspaceDeletedAt !== null)
                    repository.reviveWorkspace(key, pending.id, RECREATED_NOTE);
                const item = repository.inbox(pending.id) ?? pending;
                const conversation = repository.conversation(key) ?? known;
                repository.markAdmitted(item.id);
                const result = yield* options
                    .prepareWorkspace(conversation)
                    .pipe(
                        Effect.andThen(
                            agent.runTurn({
                                sessionId: conversation.sessionId,
                                conversationKey: key,
                                workspaceId: conversation.workspaceId,
                                messageId: item.messageId,
                                prompt: item.prompt ?? "",
                            }),
                        ),
                        Effect.result,
                    );
                // Cleanup deleted the workspace and interrupted this turn; the
                // pull request has been closed for a week, so stay silent.
                if (repository.conversation(key)?.workspaceDeletedAt != null) {
                    repository.completeInbox(item.id, "failed");
                    continue;
                }
                const succeeded =
                    result._tag === "Success" &&
                    result.success.outcome === "succeeded";
                if (!succeeded)
                    yield* Effect.logWarning("turn failed", {
                        inbox: item.id,
                        reason:
                            result._tag === "Failure"
                                ? errorSummary(result.failure)
                                : "model-outcome",
                    });
                repository.completeInbox(
                    item.id,
                    succeeded ? "complete" : "failed",
                    {
                        id: item.id,
                        kind:
                            conversation.rootCommentId === null
                                ? "issue"
                                : "review",
                        body: replyBody(
                            item.id,
                            succeeded ? result.success.text : FAILURE_REPLY,
                        ),
                    },
                );
                yield* deliverOutbox(key);
            }
        });

    /** One worker per conversation serializes its turns and replies. */
    const worker = (key: string) =>
        permits
            .withPermit(runInbox(key).pipe(Effect.andThen(deliverOutbox(key))))
            .pipe(
                Effect.provideContext(context),
                Effect.catchCause((cause) =>
                    Effect.logError("conversation worker failed", {
                        conversation: key,
                        error: causeSummary(cause),
                    }),
                ),
                Effect.ensuring(
                    Effect.suspend(() => {
                        running.delete(key);
                        interrupted.delete(key);
                        return repository.nextInbox(key) ? wake : Effect.void;
                    }),
                ),
            );

    /** Interrupts running turns whose workspace the cleanup timer deleted. */
    const interrupted = new Set<string>();
    const interruptDeleted = Effect.suspend(() =>
        Effect.forEach(
            [...running],
            (key) => {
                const conversation = repository.conversation(key);
                if (
                    conversation?.workspaceDeletedAt == null ||
                    interrupted.has(key)
                )
                    return Effect.void;
                interrupted.add(key);
                return agent.interrupt(conversation.sessionId).pipe(
                    Effect.tap(() =>
                        Effect.logInfo(
                            "interrupted turn in deleted workspace",
                            {
                                conversation: key,
                            },
                        ),
                    ),
                    Effect.ignore,
                );
            },
            { discard: true },
        ),
    );

    const sweep = Effect.gen(function* () {
        yield* routeReceived;
        yield* interruptDeleted;
        for (const key of repository.conversationsWithWork()) {
            if (running.has(key)) continue;
            running.add(key);
            yield* Effect.forkIn(worker(key), scope);
        }
    }).pipe(
        Effect.provideContext(context),
        Effect.catchCause((cause) =>
            Effect.logError("sweep failed", { error: causeSummary(cause) }),
        ),
    );

    yield* Queue.take(signals).pipe(
        Effect.timeoutOption(options.sweepInterval ?? SWEEP_INTERVAL),
        Effect.andThen(sweep),
        Effect.forever,
        Effect.forkIn(scope),
    );
    yield* wake;

    return Conversations.of({ wake });
});

export const layer = (options: ConversationsOptions) =>
    Layer.effect(Conversations, makeConversations(options));
