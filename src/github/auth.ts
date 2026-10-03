import { createHmac, createSign, timingSafeEqual } from "node:crypto";

/** Verifies GitHub's `X-Hub-Signature-256` header over the exact body bytes. */
export const verifyWebhookSignature = (
    secret: string,
    body: Uint8Array,
    header: string | undefined,
) => {
    if (!header?.startsWith("sha256=")) return false;
    const expected = Buffer.from(
        `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`,
    );
    const actual = Buffer.from(header);
    return (
        actual.length === expected.length && timingSafeEqual(actual, expected)
    );
};

export const signWebhookBody = (secret: string, body: Uint8Array) =>
    `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;

const base64url = (value: string | Buffer) =>
    Buffer.from(value).toString("base64url");

/** Short-lived RS256 JWT identifying the GitHub App itself. */
export const appJwt = (
    appId: number,
    privateKeyPem: string,
    now = Date.now(),
) => {
    const issuedAt = Math.floor(now / 1000) - 60;
    const unsigned = `${base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }))}.${base64url(
        JSON.stringify({
            iat: issuedAt,
            exp: issuedAt + 9 * 60,
            iss: String(appId),
        }),
    )}`;
    const signature = createSign("RSA-SHA256")
        .update(unsigned)
        .sign(privateKeyPem);
    return `${unsigned}.${base64url(signature)}`;
};
