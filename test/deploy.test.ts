import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { expect, it } from "vitest";
import { remoteScript } from "../deploy/exe/release";

const bashSyntax = (args: string[], input?: string) =>
    execFileSync("bash", ["-n", ...args], { input, encoding: "utf8" });

it("deployment scripts are valid bash", () => {
    const root = join(import.meta.dirname, "..", "deploy", "exe");
    bashSyntax([join(root, "host-setup.sh")]);
    bashSyntax([join(root, "provision.sh")]);
    const script = remoteScript(
        "a".repeat(40),
        "b".repeat(64),
        "/var/tmp/upload.tar",
    );
    expect(() => bashSyntax([], script)).not.toThrow();
    expect(script).not.toMatch(/token|secret|password/i);
});
