import { copyFile, mkdir, readdir, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { dirname } from "node:path";

/** WASM files that `@opencode/core` resolves next to the bundle at runtime. */
const RUNTIME_ASSETS = [
    "web-tree-sitter/tree-sitter.wasm",
    "tree-sitter-bash/tree-sitter-bash.wasm",
    "tree-sitter-powershell/tree-sitter-powershell.wasm",
    "@silvia-odwyer/photon-node/photon_rs_bg.wasm",
];

const output = new URL("./dist/", import.meta.url).pathname;
await rm(output, { recursive: true, force: true });

const jsoncEsm: Bun.BunPlugin = {
    // jsonc-parser's UMD entry uses relative requires that break once bundled.
    name: "jsonc-parser-esm",
    setup(build) {
        build.onResolve({ filter: /^jsonc-parser$/ }, (args) => ({
            path: Bun.resolveSync(args.path, args.resolveDir).replace(
                "/lib/umd/main.js",
                "/lib/esm/main.js",
            ),
        }));
    },
};

const result = await Bun.build({
    entrypoints: [new URL("./src/main.ts", import.meta.url).pathname],
    outdir: output,
    target: "node",
    naming: "main.mjs",
    plugins: [jsoncEsm],
});
for (const log of result.logs) console.error(log);
if (!result.success) throw new Error("production build failed");

// The per-conversation executor is small and must not load OpenCode.
const workspace = await Bun.build({
    entrypoints: [new URL("./src/workspace/main.ts", import.meta.url).pathname],
    outdir: output,
    target: "node",
    naming: "workspace.mjs",
});
for (const log of workspace.logs) console.error(log);
if (!workspace.success) throw new Error("workspace build failed");

const cleanup = await Bun.build({
    entrypoints: [new URL("./src/cleanup.ts", import.meta.url).pathname],
    outdir: output,
    target: "node",
    naming: "cleanup.mjs",
    plugins: [jsoncEsm],
});
for (const log of cleanup.logs) console.error(log);
if (!cleanup.success) throw new Error("cleanup build failed");

const triageFacts = await Bun.build({
    entrypoints: [new URL("./src/triage/collect.ts", import.meta.url).pathname],
    outdir: output,
    target: "node",
    naming: "triage-facts.mjs",
    plugins: [jsoncEsm],
});
for (const log of triageFacts.logs) console.error(log);
if (!triageFacts.success) throw new Error("triage facts build failed");

const importer = await Bun.build({
    entrypoints: [
        new URL("./src/admin/import-credential.ts", import.meta.url).pathname,
    ],
    outdir: output,
    target: "node",
    naming: "import-credential.mjs",
    plugins: [jsoncEsm],
});
for (const log of importer.logs) console.error(log);
if (!importer.success) throw new Error("credential importer build failed");

// exe.dev runs glibc Linux; drop the musl sidecar.
for (const name of await readdir(output))
    if (/^ffi-rs\.linux-x64-musl-.*\.node$/.test(name))
        await rm(`${output}${name}`);

const resolveFromCore = createRequire(
    Bun.resolveSync("@opencode/core/effect/app-node-platform", import.meta.dir),
).resolve;
for (const asset of RUNTIME_ASSETS) {
    const destination = `${output}node_modules/${asset}`;
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(resolveFromCore(asset), destination);
}

const source = await Bun.file(`${output}main.mjs`).text();
if (source.includes("@opencode/ai/testing") || source.includes("TestLLM"))
    throw new Error("production bundle contains the test model");
if ((await Bun.file(`${output}workspace.mjs`).text()).includes("@opencode/"))
    throw new Error("workspace bundle must not include OpenCode");
