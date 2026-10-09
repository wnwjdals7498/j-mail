import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, rm, realpath } from "node:fs/promises";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import path from "node:path";
import os from "node:os";
import { createHash } from "node:crypto";

const root = fileURLToPath(new URL("../../", import.meta.url));
const registry = "http://127.0.0.1:4873/";
async function run(args, cwd, userconfig) {
  if (!process.env.npm_execpath)
    throw new Error("Run through npm test:registry.");
  const child = spawn(
    process.execPath,
    [
      process.env.npm_execpath,
      ...args,
      "--registry",
      registry,
      "--userconfig",
      userconfig,
      "--cache",
      path.join(cwd, "cache"),
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
    ],
    { cwd, shell: false, stdio: ["ignore", "pipe", "pipe"] },
  );
  let out = "";
  child.stdout.on("data", (chunk) => (out += String(chunk)));
  child.stderr.resume();
  const timer = setTimeout(() => child.kill("SIGKILL"), 20000);
  timer.unref();
  try {
    const [code] = await once(child, "exit");
    if (code !== 0)
      throw new Error(
        `Registry CLI failed (${code}); private output withheld.`,
      );
    return out;
  } finally {
    clearTimeout(timer);
  }
}
test(
  "actual private-registry exact-version consumer matches the immutable built contracts",
  { timeout: 45000 },
  async () => {
    const profile = await realpath(
      process.env.JML_TEST_NPMRC ??
        path.resolve(root, "../.suite-runtime/j-groupware/registry/user.npmrc"),
    );
    assert.ok(
      path.relative(root, profile).startsWith(".." + path.sep),
      "Private registry profile must be outside checkout.",
    );
    const temporary = await mkdtemp(path.join(os.tmpdir(), "j-mail-registry-"));
    try {
      const response = await fetch(registry + "@j-mail%2fcontracts", {
        signal: AbortSignal.timeout(3000),
      });
      assert.equal(
        response.status,
        200,
        "Contracts must actually be published in the local registry.",
      );
      const metadata = await response.json(),
        version = JSON.parse(
          await readFile(
            path.join(root, "packages/contracts/package.json"),
            "utf8",
          ),
        ).version,
        manifest = metadata.versions[version];
      assert.equal(
        metadata.versions["0.1.0"].dist.integrity,
        "sha512-Eg800qawj5W06sISNI/cH/TfnJjRjeG9CjZad3YaQp4IqWt9dl0wgUTGYaQPpVz7FLMexua1UGoe8q3MMt1Eog==",
      );
      assert.equal(manifest.name, "@j-mail/contracts");
      assert.equal(manifest.version, version);
      const packed = JSON.parse(
        await run(
          [
            "pack",
            path.join(root, "packages/contracts"),
            "--json",
            "--pack-destination",
            temporary,
          ],
          temporary,
          profile,
        ),
      );
      const bytes = await readFile(path.join(temporary, packed[0].filename));
      assert.equal(
        manifest.dist.integrity,
        "sha512-" + createHash("sha512").update(bytes).digest("base64"),
        "Published code must match this checkout; never republish a changed version.",
      );
      await writeFile(
        path.join(temporary, "package.json"),
        JSON.stringify({
          name: "isolated-mail-consumer",
          private: true,
          type: "module",
          dependencies: { "@j-mail/contracts": version },
        }),
      );
      await run(["install"], temporary, profile);
      const lock = JSON.parse(
        await readFile(path.join(temporary, "package-lock.json"), "utf8"),
      );
      const entry = lock.packages["node_modules/@j-mail/contracts"];
      assert.equal(entry.version, version);
      assert.equal(new URL(entry.resolved).origin, new URL(registry).origin);
      assert.equal(entry.integrity, manifest.dist.integrity);
      const contracts = await import(
        path.join(temporary, "node_modules/@j-mail/contracts/dist/index.js")
      );
      assert.equal(contracts.MAIL_PATHS.messages, "/mail/messages");
      assert.equal(contracts.MAIL_LIMITS.page, 100);
      assert.equal(contracts.MAILPIT_IMAGE.includes("v1.31.4@sha256:"), true);
      assert.equal(
        contracts.mailpitEnvironment("customer-a", {
          database: "/data/mailpit.db",
          smtp: "127.0.0.1:54312",
          http: "127.0.0.1:54311",
        }).MP_MAX_MESSAGES,
        "0",
      );
      assert.equal(contracts.MAIL_PATHS.message("id"), "/mail/messages/id");
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  },
);
