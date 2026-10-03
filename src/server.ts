import { Context, Effect, FileSystem, Option } from "effect";
import {
    HttpIncomingMessage,
    HttpRouter,
    HttpServerResponse,
} from "effect/unstable/http";
import { Repository } from "./conversations/repository";
import { Conversations } from "./conversations/service";
import { verifyWebhookSignature } from "./github/auth";
import { decodeCommentEvent } from "./github/events";
import { type BotIdentity, ignoredReason } from "./github/threads";

const MAX_WEBHOOK_BYTES = 5 * 1024 * 1024;

export class WebhookSettings extends Context.Service<
    WebhookSettings,
    { readonly secret: string; readonly bot: BotIdentity }
>()("opencode-github-bot/WebhookSettings") {}

export type WebhookInput = {
    readonly event: string | undefined;
    readonly deliveryId: string | undefined;
    readonly signature: string | undefined;
    readonly body: Uint8Array;
};

/**
 * Authenticates and durably records one delivery. The returned status is only
 * a success after the delivery is persisted.
 */
export const acceptWebhook = Effect.fnUntraced(function* (input: WebhookInput) {
    const settings = yield* WebhookSettings;
    const repository = yield* Repository;
    if (!verifyWebhookSignature(settings.secret, input.body, input.signature))
        return 401;
    if (
        !input.event ||
        !input.deliveryId ||
        !/^[A-Za-z0-9-]{1,100}$/.test(input.deliveryId)
    )
        return 400;
    if (input.event === "ping") return 204;

    let payload: unknown;
    try {
        payload = JSON.parse(new TextDecoder().decode(input.body));
    } catch {
        return 400;
    }
    const event = decodeCommentEvent(input.event, payload);
    const reason = Option.match(event, {
        onNone: () => "unsupported-event",
        onSome: (value) => ignoredReason(value, settings.bot),
    });
    const inserted = repository.recordDelivery({
        id: input.deliveryId,
        event: input.event,
        payload:
            reason === undefined && Option.isSome(event)
                ? JSON.stringify(event.value)
                : null,
        ...(reason === undefined ? {} : { ignoredReason: reason }),
    });
    if (inserted && reason === undefined) yield* (yield* Conversations).wake;
    return 202;
});

export const routes = HttpRouter.use((router) =>
    Effect.gen(function* () {
        const context = yield* Effect.context<
            WebhookSettings | Repository | Conversations
        >();
        yield* router.add("GET", "/health", HttpServerResponse.text("ok"));
        yield* router.add("POST", "/github/webhook", (request) =>
            Effect.gen(function* () {
                const body = yield* request.arrayBuffer;
                const header = (name: string) => request.headers[name];
                const status = yield* acceptWebhook({
                    event: header("x-github-event"),
                    deliveryId: header("x-github-delivery"),
                    signature: header("x-hub-signature-256"),
                    body: new Uint8Array(body),
                });
                return HttpServerResponse.empty({ status });
            }).pipe(
                Effect.provideContext(context),
                Effect.provideService(
                    HttpIncomingMessage.MaxBodySize,
                    FileSystem.Size(MAX_WEBHOOK_BYTES),
                ),
                Effect.catchCause(() =>
                    Effect.succeed(HttpServerResponse.empty({ status: 500 })),
                ),
            ),
        );
    }),
);

export const serverLayer = HttpRouter.serve(routes, {
    disableLogger: true,
    disableListenLog: true,
});
